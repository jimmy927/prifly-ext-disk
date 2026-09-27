// fastdu: folder sizes on Windows drives, read from the directory listings.
//
// Windows' directory listing (FindFirstFileEx / FindNextFile) already carries
// each file's size and attributes, so a whole tree is summed without opening
// or stat-ing a single file. PowerShell's Get-ChildItem reads the same
// listings but builds an object per file, which is where its minutes went.
// Directories are listed by a pool of threads sharing one queue; the sizes are
// added up the tree once every listing is done.
//
//   fastdu.exe <depth> <minBytes> <threads> <root>...
//
// Prints one line per folder no deeper than <depth> below a root and at least
// <minBytes> in size: "bytes<TAB>files<TAB>path". While it runs, a line
// "progress<TAB>dirs<TAB>files<TAB>bytes" goes to standard error each second.
// Junctions and symbolic links are not followed: their targets are counted
// where they live. Hard links are counted at each name, as Explorer does.
//
// Built by the disk extension with the C# compiler every Windows has
// (%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe); nothing to install.

using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class FastDu
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct FindData
    {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
        public uint SizeHigh, SizeLow, Reserved0, Reserved1;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string ShortName;
    }

    const int FindExInfoBasic = 1;
    const int FindExSearchNameMatch = 0;
    const int FindFirstExLargeFetch = 2;
    const uint Directory = 0x10;
    const uint ReparsePoint = 0x400;
    static readonly IntPtr Invalid = new IntPtr(-1);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr FindFirstFileExW(string name, int level, out FindData data, int op, IntPtr filter, int flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern bool FindNextFileW(IntPtr handle, out FindData data);

    [DllImport("kernel32.dll")]
    static extern bool FindClose(IntPtr handle);

    sealed class Node
    {
        public readonly string Path;
        public readonly Node Parent;
        public readonly int Depth;
        public long Bytes;
        public long Files;
        public Node(string path, Node parent, int depth) { Path = path; Parent = parent; Depth = depth; }
    }

    static readonly Queue<Node> Work = new Queue<Node>();
    static readonly List<Node> All = new List<Node>();
    static readonly object Gate = new object();
    static int busy;
    static long dirs, files, bytes;

    static void List(Node node)
    {
        FindData data;
        // \\?\ lifts the 260-character limit on paths.
        IntPtr handle = FindFirstFileExW(@"\\?\" + node.Path + @"\*", FindExInfoBasic, out data,
            FindExSearchNameMatch, IntPtr.Zero, FindFirstExLargeFetch);
        if (handle == Invalid) return; // Access denied, or gone since: counted as empty.
        var found = new List<Node>();
        try
        {
            do
            {
                if (data.Name == "." || data.Name == "..") continue;
                if ((data.Attributes & Directory) != 0)
                {
                    if ((data.Attributes & ReparsePoint) != 0) continue;
                    found.Add(new Node(node.Path + "\\" + data.Name, node, node.Depth + 1));
                }
                else
                {
                    long size = ((long)data.SizeHigh << 32) | data.SizeLow;
                    node.Bytes += size;
                    node.Files += 1;
                }
            } while (FindNextFileW(handle, out data));
        }
        finally { FindClose(handle); }
        Interlocked.Add(ref files, node.Files);
        Interlocked.Add(ref bytes, node.Bytes);
        Interlocked.Increment(ref dirs);
        lock (Gate)
        {
            foreach (var child in found) { Work.Enqueue(child); All.Add(child); }
            if (found.Count > 0) Monitor.PulseAll(Gate);
        }
    }

    static void Worker()
    {
        while (true)
        {
            Node node;
            lock (Gate)
            {
                while (Work.Count == 0)
                {
                    if (busy == 0) { Monitor.PulseAll(Gate); return; }
                    Monitor.Wait(Gate);
                }
                node = Work.Dequeue();
                busy += 1;
            }
            List(node);
            lock (Gate)
            {
                busy -= 1;
                if (busy == 0 && Work.Count == 0) Monitor.PulseAll(Gate);
            }
        }
    }

    static int Main(string[] args)
    {
        if (args.Length < 4)
        {
            Console.Error.WriteLine("usage: fastdu <depth> <minBytes> <threads> <root>...");
            return 2;
        }
        int depth = int.Parse(args[0]);
        long minBytes = long.Parse(args[1]);
        int threads = int.Parse(args[2]);
        for (int i = 3; i < args.Length; i++)
        {
            var root = new Node(args[i].TrimEnd('\\'), null, 0);
            All.Add(root);
            Work.Enqueue(root);
        }
        var pool = new List<Thread>();
        for (int i = 0; i < threads; i++)
        {
            var thread = new Thread(Worker) { IsBackground = true };
            thread.Start();
            pool.Add(thread);
        }
        var reporter = new Thread(() =>
        {
            while (true)
            {
                Thread.Sleep(1000);
                Console.Error.WriteLine("progress\t" + Interlocked.Read(ref dirs) + "\t" +
                    Interlocked.Read(ref files) + "\t" + Interlocked.Read(ref bytes));
                Console.Error.Flush();
            }
        }) { IsBackground = true };
        reporter.Start();
        foreach (var thread in pool) thread.Join();

        // Children were added after their parents: summing from the end adds
        // every folder into its parent after all of its own children.
        for (int i = All.Count - 1; i >= 0; i--)
        {
            var node = All[i];
            if (node.Parent != null) { node.Parent.Bytes += node.Bytes; node.Parent.Files += node.Files; }
        }
        var output = new StringBuilder();
        foreach (var node in All)
        {
            if (node.Depth <= depth && node.Bytes >= minBytes)
                output.Append(node.Bytes).Append('\t').Append(node.Files).Append('\t').Append(node.Path).Append('\n');
        }
        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        stdout.Write(output.ToString());
        stdout.Flush();
        return 0;
    }
}
