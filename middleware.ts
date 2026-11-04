import { NextResponse } from 'next/server';
export function middleware() {
 const response = NextResponse.next();
 response.headers.set('Referrer-Policy','no-referrer');
 response.headers.set('X-Robots-Tag','noindex');
 response.headers.set('Cache-Control','no-store');
 return response;
}
export const config = {matcher:['/s/:path*','/api/share/:path*']};
