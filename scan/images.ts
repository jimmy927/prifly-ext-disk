/**
 * The virtual disks WSL and Docker Desktop live in.
 *
 * A `.vhdx` grows as its Linux writes and does not shrink when files are
 * deleted inside it. A sparse one hands blocks back to Windows once they are
 * trimmed (`fstrim`), with nothing stopped; any other needs compacting
 * (`diskpart … compact vdisk`) while its distro is stopped. On 2026-09-26
 * Docker Desktop's `docker_data.vhdx` was 822 GB holding 64 GB of images and
 * volumes; compacted, it was 66 GB.
 */

import { ON_WINDOWS, powershell } from "./run";
import type { Candidate, Usage } from "./types";

export type DiskImage = {
  /** The WSL distro it belongs to: "Ubuntu-20.04", "docker-desktop". */
  distro: string;
  /** Windows path, `C:\…`. */
  path: string;
  /** The size it claims. */
  bytes: number;
  /** What it takes on the drive; less than `bytes` when sparse. */
  allocated: number;
  sparse: boolean;
};

/**
 * Every registered distro's folder from the registry, the `.vhdx` files in it,
 * and — for Docker Desktop, whose data disk sits beside its distro folder —
 * `..\disk\docker_data.vhdx`. A sparse file's `Length` is what it claims, not
 * what it takes: `GetCompressedFileSizeW` says that.
 */
const LIST_IMAGES = `
$ErrorActionPreference = "SilentlyContinue"
Add-Type -Namespace Disk -Name Native -MemberDefinition '
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  public static extern uint GetCompressedFileSizeW(string path, out uint high);'
$out = @()
Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss | ForEach-Object {
  $p = Get-ItemProperty $_.PSPath
  $base = $p.BasePath -replace '^\\\\\\\\\\?\\\\', ''
  $dirs = @($base)
  if ($p.DistributionName -like "docker-desktop*") { $dirs += (Join-Path (Split-Path $base) "disk") }
  foreach ($d in $dirs) {
    Get-ChildItem -LiteralPath $d -Filter *.vhdx -Force | ForEach-Object {
      $high = [uint32]0
      $low = [Disk.Native]::GetCompressedFileSizeW($_.FullName, [ref]$high)
      $out += [pscustomobject]@{ distro = $p.DistributionName; path = $_.FullName; bytes = $_.Length;
        allocated = ([double]$high * 4294967296 + $low);
        sparse = (($_.Attributes -band [IO.FileAttributes]::SparseFile) -ne 0) }
    }
  }
}
ConvertTo-Json -Compress -InputObject @($out)
`;

export async function readImages(): Promise<DiskImage[]> {
  const out = (await powershell(LIST_IMAGES)).trim();
  if (out === "") return [];
  const seen = new Set<string>();
  return (JSON.parse(out) as DiskImage[]).filter((image) => {
    const key = image.path.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Below this much slack giving space back is not worth doing. */
const WORTH_IT = 10e9;

function blockersFor(docker: boolean): string[] {
  return [
    docker
      ? "Docker Desktop stops while it runs: every container stops and restarts after"
      : ON_WINDOWS
        ? "`wsl --shutdown` ends every process in WSL"
        : "`wsl --shutdown` ends every WSL session, prifly's included",
    "compacting needs an administrator prompt on Windows",
  ];
}

/**
 * An image as usage, and as a candidate when it takes much more than it holds.
 * `insideBytes` is what its Linux says it uses, when known.
 */
export function imageFindings(
  image: DiskImage,
  insideBytes: number | null,
  drive: string,
): { usage: Usage; candidate: Candidate | null } {
  const docker = image.distro.startsWith("docker-desktop");
  // Docker Desktop has two: its small system disk and the data disk that grows.
  const dockerDisk = image.path.toLowerCase().endsWith("docker_data.vhdx") ? "data" : "system";
  const what = docker
    ? `Docker Desktop ${dockerDisk} disk image`
    : `WSL disk image (${image.distro})`;
  const usage: Usage = { drive, path: image.path, bytes: image.allocated, what };
  if (insideBytes === null || image.allocated - insideBytes < WORTH_IT) {
    return { usage, candidate: null };
  }
  const holding = `takes ${fmtGb(image.allocated)} on ${drive}, holds ${fmtGb(insideBytes)}`;
  const candidate: Candidate = image.sparse
    ? {
        id: `disk-image:${image.path}`,
        kind: "disk-image",
        title: `Trim ${what}`,
        path: image.path,
        bytes: image.allocated - insideBytes,
        drive,
        safety: "safe",
        why: `sparse: ${holding}; fstrim gives the rest back without stopping anything`,
        blockers: [],
      }
    : {
        id: `disk-image:${image.path}`,
        kind: "disk-image",
        title: `Compact ${what}`,
        path: image.path,
        bytes: image.allocated - insideBytes,
        drive,
        safety: "downtime",
        why: holding,
        blockers: blockersFor(docker),
      };
  return { usage, candidate };
}

function fmtGb(bytes: number): string {
  return `${Math.round(bytes / 1e9)} GB`;
}
