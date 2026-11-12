// ArcGIS OAuth 2.0 sign-in for a browser-only app (authorization code + PKCE, no secret).
import { CLIENT_ID, PORTAL } from './config.js';

const KEY = 'retiring-tool-session';
const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');

const base64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function signIn() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(12)));
  const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  sessionStorage.setItem(KEY + '-pending', JSON.stringify({ verifier, state }));
  location.assign(`${PORTAL}/sharing/rest/oauth2/authorize?` + new URLSearchParams({
    client_id: CLIENT_ID, response_type: 'code', redirect_uri: redirectUri(),
    code_challenge: challenge, code_challenge_method: 'S256', state, expiration: '120',
  }));
}

export function signOut() {
  sessionStorage.removeItem(KEY);
  location.assign(redirectUri());
}

/** Returns { token, username, expires } if signed in, completing a sign-in redirect if one is in progress. */
export async function currentSession() {
  const query = new URLSearchParams(location.search);
  if (query.has('code') || query.has('error')) {
    const pending = JSON.parse(sessionStorage.getItem(KEY + '-pending') || 'null');
    sessionStorage.removeItem(KEY + '-pending');
    history.replaceState(null, '', redirectUri());
    if (query.has('error')) throw new Error('Sign-in failed: ' + (query.get('error_description') || query.get('error')));
    if (!pending || pending.state !== query.get('state')) throw new Error('Sign-in response did not match this browser tab.');
    const response = await fetch(`${PORTAL}/sharing/rest/oauth2/token`, {
      method: 'POST',
      body: new URLSearchParams({
        client_id: CLIENT_ID, grant_type: 'authorization_code', code: query.get('code'),
        redirect_uri: redirectUri(), code_verifier: pending.verifier, f: 'json',
      }),
    });
    const result = await response.json();
    if (!result.access_token) throw new Error('Sign-in failed: ' + ((result.error && (result.error.message || result.error_description)) || 'no token returned'));
    const session = { token: result.access_token, username: result.username, expires: Date.now() + result.expires_in * 1000 };
    sessionStorage.setItem(KEY, JSON.stringify(session));
    return session;
  }
  const session = JSON.parse(sessionStorage.getItem(KEY) || 'null');
  return session && session.expires > Date.now() + 60000 ? session : null;
}
