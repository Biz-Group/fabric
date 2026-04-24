const RESERVED_SUBDOMAINS = new Set(["www", "app"]);
const TENANT_SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function getHostname(host: string | null | undefined): string | null {
  if (!host) return null;

  const value = host.trim().toLowerCase();
  if (!value || /[\s,/]/.test(value)) return null;

  const colonIndex = value.indexOf(":");
  if (colonIndex === -1) return value.replace(/\.$/, "");

  const hostname = value.slice(0, colonIndex);
  const port = value.slice(colonIndex + 1);
  if (!hostname || !/^\d+$/.test(port)) return null;

  return hostname.replace(/\.$/, "");
}

export function isValidTenantSubdomain(subdomain: string): boolean {
  return (
    TENANT_SUBDOMAIN_PATTERN.test(subdomain) &&
    !RESERVED_SUBDOMAINS.has(subdomain)
  );
}

export function getTenantSubdomain(
  host: string | null | undefined,
  rootDomain: string | null | undefined,
): string | null {
  const hostname = getHostname(host);
  const rootHostname = getHostname(rootDomain);

  if (!hostname || !rootHostname) return null;
  if (hostname === rootHostname || hostname === `www.${rootHostname}`) {
    return null;
  }
  if (!hostname.endsWith(`.${rootHostname}`)) return null;

  const subdomain = hostname.slice(0, -rootHostname.length - 1);
  if (!isValidTenantSubdomain(subdomain)) return null;

  return subdomain;
}
