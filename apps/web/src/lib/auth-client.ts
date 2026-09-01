import { apiKeyClient } from "@better-auth/api-key/client";
import {
  adminClient,
  anonymousClient,
  deviceAuthorizationClient,
  emailOTPClient,
  genericOAuthClient,
  inferAdditionalFields,
  lastLoginMethodClient,
  magicLinkClient,
  organizationClient,
} from "better-auth/client/plugins";
import type { AccessControl } from "better-auth/plugins/access";
import { createAuthClient } from "better-auth/react";
import { ac, admin, member, owner, viewer } from "./permissions";

const getBaseURL = () => {
  const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:1337";
  try {
    const url = new URL(apiUrl, window.location.origin);
    return url.origin;
  } catch {
    return apiUrl.split("/").slice(0, 3).join("/");
  }
};

const getBasePath = () => {
  const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:1337";
  try {
    const url = new URL(apiUrl, window.location.origin);
    const apiPath = url.pathname.replace(/\/$/, "") || "/api";
    return `${apiPath}/auth`;
  } catch {
    return "/api/auth";
  }
};

export const authClient = createAuthClient({
  baseURL: getBaseURL(),
  basePath: getBasePath(),
  plugins: [
    anonymousClient(),
    lastLoginMethodClient(),
    magicLinkClient(),
    emailOTPClient(),
    organizationClient({
      // Same widening as the server plugin in `apps/api/src/auth.ts`: our
      // narrow `statement` shape makes `ac`'s inferred `newRole` generic
      // incompatible with better-auth's looser `AccessControl` type.
      ac: ac as AccessControl,
      roles: {
        viewer,
        member,
        admin,
        owner,
      },
      dynamicAccessControl: {
        enabled: true,
      },
    }),
    genericOAuthClient(),
    deviceAuthorizationClient(),
    apiKeyClient(),
    adminClient(),
    inferAdditionalFields({
      user: {
        locale: {
          type: "string",
          required: false,
          input: true,
        },
      },
    }),
  ],
});
