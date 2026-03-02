import type { PermissionProfile } from "../../types/contracts.js";

type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type ApprovalMode = "never" | "on-request" | "on-failure" | "untrusted";

const PROFILE_ORDER: PermissionProfile[] = ["safe", "workspace", "full"];

export function profileRank(profile: PermissionProfile): number {
  return PROFILE_ORDER.indexOf(profile);
}

export function minProfile(a: PermissionProfile, b: PermissionProfile): PermissionProfile {
  return profileRank(a) <= profileRank(b) ? a : b;
}

export function toRuntimePermission(profile: PermissionProfile): {
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalMode;
  networkAccessEnabled: boolean;
} {
  if (profile === "safe") {
    return {
      sandboxMode: "read-only",
      approvalPolicy: "on-request",
      networkAccessEnabled: false
    };
  }

  if (profile === "workspace") {
    return {
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      networkAccessEnabled: false
    };
  }

  return {
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
    networkAccessEnabled: true
  };
}
