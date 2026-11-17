import { NextResponse, type NextRequest } from 'next/server';
import { homePath } from './lib/start-page';

/**
 * Sends someone who is plainly not signed in straight to the sign-in page, before any screen is drawn. Without this
 * the browser first opens the dashboard, shows "Loading", asks the API whether the person is signed in, and only
 * then moves to /login. The signal is a small marker cookie the web app sets after signing in (see lib/auth).
 * It holds nothing secret and proves nothing: the API still decides who may see what. If the marker is there but
 * the session is gone, the app's own check still sends the person to /login, as before.
 */
export const SIGNED_IN_MARKER = 'ah_in';

export function proxy(request: NextRequest): NextResponse {
  const signedIn = request.cookies.has(SIGNED_IN_MARKER);
  const { pathname } = request.nextUrl;
  if (pathname === '/') return NextResponse.redirect(new URL(signedIn ? homePath(request.cookies.get('ah_home')?.value) : '/login', request.url));
  if (!signedIn) return NextResponse.redirect(new URL('/login', request.url));
  return NextResponse.next();
}

// Only the screens that need a sign-in. The sign-in, password reset and guest meeting pages are left alone.
export const config = {
  matcher: ['/', '/dashboard/:path*', '/leads/:path*', '/calls/:path*', '/dialer/:path*', '/communications/:path*', '/video/:path*', '/attendance/:path*', '/leave/:path*', '/salary/:path*', '/reports/:path*', '/imports/:path*', '/notifications/:path*', '/account/:path*', '/settings/:path*'],
};
