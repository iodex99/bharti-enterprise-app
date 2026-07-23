/**
 * `cookie-parser` shim: populate req.cookies from the Cookie header.
 * The in-app "cookie" is carried by the bridge rather than a browser cookie jar, but
 * the session code path stays identical to the server's.
 */

type Req = { headers: Record<string, string>; cookies: Record<string, string> };
type Next = () => void;

export default function cookieParser() {
  return (req: Req, _res: unknown, next: Next): void => {
    const header = req.headers['cookie'];
    const jar: Record<string, string> = {};
    if (header) {
      for (const part of header.split(';')) {
        const index = part.indexOf('=');
        if (index === -1) continue;
        const name = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        if (!name) continue;
        try {
          jar[name] = decodeURIComponent(value);
        } catch {
          jar[name] = value;
        }
      }
    }
    req.cookies = jar;
    next();
  };
}
