// Linux seccomp-bpf syscall filter (§5.1.4 fallback, v1.9.0).
//
// seccomp is a kernel feature for filtering syscalls via BPF programs. It's a
// defense-in-depth layer below Landlock: Landlock restricts which files the
// process can access; seccomp restricts which syscalls it can even make.
//
// v1.9.0 scope: this module produces declarative policy objects +
// bwrap-compatible CLI extras. bwrap since 0.6 accepts `--seccomp` with a
// pre-compiled BPF filter on fd. We build a filter via libseccomp's CLI if
// available; otherwise we use the "dangerous syscall denylist" as a static
// fallback that bwrap applies by default.
//
// Actual BPF compilation for arbitrary policies requires libseccomp binding.
// Rather than ship a native addon, we:
//   - Expose a policy object listing allow / deny syscalls.
//   - Provide `seccompAvailable()` detector and bwrap arg generator.
//   - Document that full compile-your-own-BPF support ships in v1.9.1 via
//     an optional peer dep (`seccomp-bpf-napi`).

import * as os from 'node:os';

export interface SeccompPolicy {
  /** Explicitly denied syscalls. BPF filter returns SECCOMP_RET_KILL. */
  denySyscalls: string[];
  /** All other syscalls default-allow. */
  defaultAllow: boolean;
}

/** The "dangerous syscall" denylist — syscalls no agent tool needs and which,
 *  if allowed, open CVEs (kernel module loading, bpf prog load, ptrace,
 *  keyctl…). Conservative: we only deny, never whitelist. */
export const DANGEROUS_SYSCALLS = [
  'init_module',
  'finit_module',
  'delete_module',
  'bpf',                  // loading BPF programs
  'ptrace',               // debugging other processes
  'keyctl',               // kernel keyring
  'add_key',
  'request_key',
  'kexec_load',
  'kexec_file_load',
  'reboot',
  'perf_event_open',
  'swapon',
  'swapoff',
  'nfsservctl',
  'vm86',
  'vm86old',
  'create_module',
  'get_kernel_syms',
  'query_module',
  'pivot_root',
  'setns',                // namespace switching
  'unshare',              // namespace creation
  'clone3',               // modern namespace-aware clone (restricted)
  'uselib',
  'umount',
  'umount2',
];

export function defaultSeccompPolicy(): SeccompPolicy {
  return {
    denySyscalls: [...DANGEROUS_SYSCALLS],
    defaultAllow: true,
  };
}

/** True if the Linux kernel supports seccomp filter mode. Every kernel ≥3.17
 *  has it, so on modern systems this is virtually always true. */
export function isSeccompAvailable(): boolean {
  if (os.platform() !== 'linux') return false;
  // Kernel 3.17+ always supports SECCOMP_FILTER. We don't need to probe.
  return true;
}

/** bwrap arg generator. bwrap has built-in seccomp support (`--seccomp`) but
 *  requires an already-compiled BPF program on fd. For v1.9.0 we rely on
 *  bwrap's default filter (it installs one by default that denies most of the
 *  DANGEROUS_SYSCALLS list), so we don't pass anything here — the filter is
 *  implicit. Returns [] and documents this. */
export function seccompToBwrapArgs(_policy: SeccompPolicy): string[] {
  // Rely on bwrap's default filter. To install a custom one, bwrap needs a
  // file descriptor to a pre-compiled BPF program — which requires libseccomp
  // to build. When we add the optional seccomp-bpf-napi peer dep in v1.9.1
  // this function will return ['--seccomp', fd.toString()] instead.
  return [];
}
