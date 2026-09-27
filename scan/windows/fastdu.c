/*
 * fastdu: folder sizes on Windows drives, from the directory listings alone.
 *
 * The C version of fastdu.cs, for speed. Where the C# one spent its time:
 *   - opening each of the 560,000 folders on C: by its full path, which the
 *     kernel parses component by component. Here a folder is opened relative
 *     to its parent's open handle (NtOpenFile with RootDirectory), so only its
 *     own name is looked up;
 *   - a managed string per file name and one shared garbage-collected heap
 *     for all threads. Here entries are read in place from the kernel's
 *     buffer; only folder names are copied, into per-thread arenas;
 *   - FindNextFile's small batches. Here NtQueryDirectoryFile fills a
 *     256 KB buffer per call.
 * A thread walks its own subtree depth-first, keeping parent handles open, and
 * hands folders to a shared stack only while another thread is idle.
 *
 *   fastdu.exe <depth> <minBytes> <threads> <root>...
 *
 * Prints "bytes<TAB>files<TAB>path" for each folder no deeper than <depth>
 * below a root and at least <minBytes>, and "progress<TAB>dirs<TAB>files<TAB>
 * bytes" on standard error each second. Sizes are file lengths, as Explorer
 * shows them. Junctions and symbolic links are not followed; hard links are
 * counted at each name.
 */

#define WIN32_LEAN_AND_MEAN
#define UNICODE
#include <windows.h>
#include <winternl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#pragma comment(lib, "ntdll.lib")

/* ---- NT declarations winternl.h leaves out ---- */

typedef struct {
    ULONG NextEntryOffset;
    ULONG FileIndex;
    LARGE_INTEGER CreationTime, LastAccessTime, LastWriteTime, ChangeTime;
    LARGE_INTEGER EndOfFile;
    LARGE_INTEGER AllocationSize;
    ULONG FileAttributes;
    ULONG FileNameLength;
    WCHAR FileName[1];
} DIR_INFO;

#define FileDirectoryInformationClass 1
#define STATUS_NO_MORE_FILES_ ((NTSTATUS)0x80000006L)

NTSYSCALLAPI NTSTATUS NTAPI NtQueryDirectoryFile(HANDLE, HANDLE, PVOID, PVOID, PIO_STATUS_BLOCK,
                                                 PVOID, ULONG, ULONG, BOOLEAN, PUNICODE_STRING,
                                                 BOOLEAN);

/* ---- per-thread memory: bump allocation, never freed before exit ---- */

typedef struct {
    char *at;
    size_t left;
} Arena;

static void *take(Arena *arena, size_t size) {
    size = (size + 15) & ~(size_t)15;
    if (arena->left < size) {
        size_t chunk = size > (4u << 20) ? size : (4u << 20);
        arena->at = (char *)malloc(chunk);
        if (arena->at == NULL) {
            fprintf(stderr, "out of memory\n");
            ExitProcess(3);
        }
        arena->left = chunk;
    }
    void *out = arena->at;
    arena->at += size;
    arena->left -= size;
    return out;
}

/* ---- the tree ---- */

typedef struct Node {
    struct Node *parent;
    WCHAR *name; /* its own name; a root's is its whole path */
    USHORT nameLength; /* in bytes */
    int depth;
    volatile LONG64 bytes; /* its subtree, once complete */
    volatile LONG64 files;
    volatile LONG pending; /* subfolders not yet complete, plus its own listing */
} Node;

static int maxDepth;
static LONG64 minBytes;

/* Folders to report, no deeper than maxDepth: few, so one lock is enough. */
static SRWLOCK shownLock = SRWLOCK_INIT;
static Node **shown;
static size_t shownCount, shownCap;

static void show(Node *node) {
    AcquireSRWLockExclusive(&shownLock);
    if (shownCount == shownCap) {
        shownCap = shownCap ? shownCap * 2 : 1024;
        shown = (Node **)realloc(shown, shownCap * sizeof *shown);
    }
    shown[shownCount++] = node;
    ReleaseSRWLockExclusive(&shownLock);
}

/* A folder whose listing and every subfolder are done adds itself to its parent. */
static void complete(Node *node) {
    while (node != NULL) {
        if (InterlockedDecrement(&node->pending) != 0) return;
        Node *parent = node->parent;
        if (parent == NULL) return;
        InterlockedAdd64(&parent->bytes, node->bytes);
        InterlockedAdd64(&parent->files, node->files);
        node = parent;
    }
}

/* ---- shared work: a stack of folders to open by full path ---- */

static SRWLOCK workLock = SRWLOCK_INIT;
static CONDITION_VARIABLE workReady = CONDITION_VARIABLE_INIT;
static Node **work;
static size_t workCount, workCap;
static volatile LONG idle;
static int threads;
static volatile LONG finished;

static volatile LONG64 totalDirs, totalFiles, totalBytes;

static void give(Node *node) {
    AcquireSRWLockExclusive(&workLock);
    if (workCount == workCap) {
        workCap = workCap ? workCap * 2 : 4096;
        work = (Node **)realloc(work, workCap * sizeof *work);
    }
    work[workCount++] = node;
    ReleaseSRWLockExclusive(&workLock);
    WakeConditionVariable(&workReady);
}

/*
 * The NT path of a folder given away by its parent's thread: "\??\" + the
 * root as given + "\" + each name down to it. A drive's root alone gets its
 * backslash — "\??\C:" is the volume itself, not its root folder.
 */
static WCHAR *fullPath(Node *node, Arena *arena, USHORT *length) {
    Node *chain[512];
    int depth = 0;
    size_t chars = 4;
    for (Node *at = node; at != NULL && depth < 512; at = at->parent) {
        chain[depth++] = at;
        chars += at->nameLength / 2 + 1;
    }
    WCHAR *out = (WCHAR *)take(arena, (chars + 2) * sizeof(WCHAR));
    size_t used = 4;
    memcpy(out, L"\\??\\", 4 * sizeof(WCHAR));
    for (int i = depth - 1; i >= 0; i--) {
        if (i != depth - 1) out[used++] = L'\\';
        memcpy(out + used, chain[i]->name, chain[i]->nameLength);
        used += chain[i]->nameLength / 2;
    }
    if (node->parent == NULL && node->nameLength == 4 && node->name[1] == L':') out[used++] = L'\\';
    out[used] = 0;
    *length = (USHORT)(used * sizeof(WCHAR));
    return out;
}

static HANDLE openDir(HANDLE parent, WCHAR *name, USHORT length) {
    UNICODE_STRING path = {length, length, name};
    OBJECT_ATTRIBUTES attributes;
    InitializeObjectAttributes(&attributes, &path, OBJ_CASE_INSENSITIVE, parent, NULL);
    IO_STATUS_BLOCK status;
    HANDLE handle;
    NTSTATUS result = NtOpenFile(&handle, FILE_LIST_DIRECTORY | SYNCHRONIZE, &attributes, &status,
                                 FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                 FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT |
                                     FILE_OPEN_REPARSE_POINT);
    return result < 0 ? NULL : handle;
}

#define BUFFER (256 * 1024)

typedef struct {
    Arena arena;
    BYTE *buffer;
} Worker;

static Node *newNode(Worker *self, Node *parent, const WCHAR *name, USHORT length) {
    Node *node = (Node *)take(&self->arena, sizeof(Node));
    node->parent = parent;
    node->name = (WCHAR *)take(&self->arena, length + sizeof(WCHAR));
    memcpy(node->name, name, length);
    node->name[length / 2] = 0;
    node->nameLength = length;
    node->depth = parent == NULL ? 0 : parent->depth + 1;
    node->bytes = 0;
    node->files = 0;
    node->pending = 1;
    if (node->depth <= maxDepth) show(node);
    return node;
}

/*
 * List one open folder, then walk its subfolders depth-first from this
 * handle — except those given away to idle threads.
 */
static void walk(Worker *self, Node *node, HANDLE handle) {
    Node **children = NULL;
    size_t count = 0, cap = 0;
    LONG64 bytes = 0, files = 0;
    IO_STATUS_BLOCK status;
    BOOLEAN restart = TRUE;
    for (;;) {
        NTSTATUS result = NtQueryDirectoryFile(handle, NULL, NULL, NULL, &status, self->buffer,
                                               BUFFER, FileDirectoryInformationClass, FALSE, NULL,
                                               restart);
        restart = FALSE;
        /*
         * Only "no more files" ends a listing. A batch that leaves room in the
         * buffer is not the end: NTFS returns short batches mid-folder, and
         * stopping at one counted 1,171,304 files on C: where there were
         * 1,856,491 (2026-09-27).
         */
        if (result < 0 || result == STATUS_NO_MORE_FILES_) break;
        DIR_INFO *entry = (DIR_INFO *)self->buffer;
        for (;;) {
            if (entry->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
                USHORT length = (USHORT)entry->FileNameLength;
                BOOL dot = (length == 2 && entry->FileName[0] == L'.') ||
                           (length == 4 && entry->FileName[0] == L'.' && entry->FileName[1] == L'.');
                if (!dot && !(entry->FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
                    if (count == cap) {
                        size_t grown = cap ? cap * 2 : 16;
                        Node **more = (Node **)take(&self->arena, grown * sizeof *more);
                        if (count) memcpy(more, children, count * sizeof *more);
                        children = more;
                        cap = grown;
                    }
                    children[count++] = newNode(self, node, entry->FileName, length);
                }
            } else {
                bytes += entry->EndOfFile.QuadPart;
                files += 1;
            }
            if (entry->NextEntryOffset == 0) break;
            entry = (DIR_INFO *)((BYTE *)entry + entry->NextEntryOffset);
        }
    }
    InterlockedAdd64(&node->bytes, bytes);
    InterlockedAdd64(&node->files, files);
    InterlockedIncrement64(&totalDirs);
    InterlockedAdd64(&totalFiles, files);
    InterlockedAdd64(&totalBytes, bytes);
    /* Each child is one more thing this folder waits for; its own listing is done. */
    InterlockedAdd(&node->pending, (LONG)count);
    for (size_t i = 0; i < count; i++) {
        Node *child = children[i];
        if (idle > 0 && i + 1 < count) {
            give(child);
            continue;
        }
        HANDLE sub = openDir(handle, child->name, child->nameLength);
        if (sub == NULL) {
            complete(child); /* unreadable: counted as empty */
            continue;
        }
        walk(self, child, sub);
    }
    CloseHandle(handle);
    complete(node);
}

static DWORD WINAPI worker(LPVOID unused) {
    (void)unused;
    Worker self = {{NULL, 0}, (BYTE *)VirtualAlloc(NULL, BUFFER, MEM_COMMIT, PAGE_READWRITE)};
    for (;;) {
        AcquireSRWLockExclusive(&workLock);
        InterlockedIncrement(&idle);
        while (workCount == 0) {
            if (idle == threads) {
                /* Nothing queued and nobody walking: the walk is over. */
                finished = 1;
                ReleaseSRWLockExclusive(&workLock);
                WakeAllConditionVariable(&workReady);
                return 0;
            }
            if (finished) {
                ReleaseSRWLockExclusive(&workLock);
                return 0;
            }
            SleepConditionVariableSRW(&workReady, &workLock, INFINITE, 0);
        }
        Node *node = work[--workCount];
        InterlockedDecrement(&idle);
        ReleaseSRWLockExclusive(&workLock);
        USHORT length;
        WCHAR *path = fullPath(node, &self.arena, &length);
        HANDLE handle = openDir(NULL, path, length);
        if (handle == NULL) {
            complete(node);
            continue;
        }
        walk(&self, node, handle);
    }
}

static DWORD WINAPI reporter(LPVOID unused) {
    (void)unused;
    for (;;) {
        Sleep(1000);
        fprintf(stderr, "progress\t%lld\t%lld\t%lld\n", totalDirs, totalFiles, totalBytes);
        fflush(stderr);
    }
}

/* The path as printed: the root as given, then each name. */
static void printPath(FILE *out, Node *node) {
    if (node->parent != NULL) {
        printPath(out, node->parent);
        fputc('\\', out);
    }
    char utf8[4 * 260 + 8];
    int n = WideCharToMultiByte(CP_UTF8, 0, node->name, node->nameLength / 2, utf8,
                                (int)sizeof utf8, NULL, NULL);
    fwrite(utf8, 1, (size_t)n, out);
}

int wmain(int argc, WCHAR **argv) {
    if (argc < 5) {
        fprintf(stderr, "usage: fastdu <depth> <minBytes> <threads> <root>...\n");
        return 2;
    }
    maxDepth = _wtoi(argv[1]);
    minBytes = _wtoi64(argv[2]);
    threads = _wtoi(argv[3]);
    if (threads < 1) threads = 1;
    Arena main = {NULL, 0};
    Node **roots = (Node **)malloc((size_t)(argc - 4) * sizeof *roots);
    for (int i = 4; i < argc; i++) {
        WCHAR *root = argv[i];
        size_t length = wcslen(root);
        while (length > 2 && root[length - 1] == L'\\') length--;
        Worker none = {main, NULL};
        roots[i - 4] = newNode(&none, NULL, root, (USHORT)(length * sizeof(WCHAR)));
        main = none.arena;
        give(roots[i - 4]);
    }
    CreateThread(NULL, 0, reporter, NULL, 0, NULL);
    HANDLE *pool = (HANDLE *)malloc((size_t)threads * sizeof *pool);
    for (int i = 0; i < threads; i++) pool[i] = CreateThread(NULL, 1 << 20, worker, NULL, 0, NULL);
    WaitForMultipleObjects((DWORD)threads, pool, TRUE, INFINITE);

    /* Printed through a big buffer: some thousand lines at most. */
    static char out[1 << 20];
    setvbuf(stdout, out, _IOFBF, sizeof out);
    for (size_t i = 0; i < shownCount; i++) {
        Node *node = shown[i];
        if (node->bytes < minBytes) continue;
        fprintf(stdout, "%lld\t%lld\t", node->bytes, node->files);
        printPath(stdout, node);
        fputc('\n', stdout);
    }
    fflush(stdout);
    return 0;
}
