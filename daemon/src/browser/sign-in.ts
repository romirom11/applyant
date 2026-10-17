// Sign-in walls. Delivery never signs in for the candidate: passwords are never filled (the
// snapshot leaves them out) and account controls ("Login with GitHub", "Sign up", "Увійти") are
// never pressed. A page that asks for a sign-in stops delivery before anything (more) is sent;
// the candidate signs in once in the sign-in window (login-window.ts), and the session stays in
// Applyant's profile for the next try.
//
// Some job sites take applications only from signed-in candidates (Djinni). Their forms are read
// in Applyant's signed-in profile, and their signed-out page is recognised before anything is
// filled, so nothing goes out through the anonymous form.
import type { Page } from 'playwright';
import { platformName, platformOf } from './guardrails.ts';
import { asksSignIn, snapshotForm } from './snapshot.ts';

export interface SignInSite {
  name: string;
  /** Hosts (and their subdomains) of the site. */
  hosts: string[];
  /** Where the sign-in window opens for it. */
  signInUrl: string;
}

export const SIGN_IN_SITES = {
  djinni: { name: 'Djinni', hosts: ['djinni.co'], signInUrl: 'https://djinni.co/login' },
} satisfies Record<string, SignInSite>;
export type SignInSiteKey = keyof typeof SIGN_IN_SITES;

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const onHost = (host: string, h: string) => host === h || host.endsWith(`.${h}`);

/** The sign-in site `url` belongs to, or null. */
export function signInSiteOf(
  url: string | null | undefined,
): (SignInSite & { key: SignInSiteKey }) | null {
  const host = hostOf(url);
  if (!host) return null;
  for (const [key, site] of Object.entries(SIGN_IN_SITES)) {
    if (site.hosts.some((h) => onHost(host, h))) return { key: key as SignInSiteKey, ...site };
  }
  return null;
}

/** The host the candidate signs in to: the address's host without "www.". */
export function siteHost(url: string): string {
  return hostOf(url)?.replace(/^www\./, '') ?? url;
}

/** What the candidate calls the site (Djinni, LinkedIn), or null for any other. */
function knownName(url: string): string | null {
  const platform = platformOf(url);
  return signInSiteOf(url)?.name ?? (platform ? platformName(platform) : null);
}

/** Controls that sign in, sign up or hand over to an identity provider: never pressed. */
export const ACCOUNT_CONTROL = new RegExp(
  [
    // Not "Register your interest" (a talent pool's submit).
    String.raw`\b(log ?in|log ?on|sign ?in|sign ?up|register(?! (your |my )?interest)|create (an |a |your )?(free )?account)\b`,
    // Not "Continue with your application": only the ways to sign in.
    String.raw`\bcontinue (with|via|using) (e-?mail|sso|phone)\b`,
    String.raw`\b(with|via|using) (github|gitlab|google|linkedin|xing|indeed|apple|facebook|microsoft|twitter)\b`,
    String.raw`\b(anmelden|einloggen|registrieren|konto erstellen|se connecter|connexion|s'inscrire|créer un compte|iniciar sesión|registrarse|crear (una )?cuenta|accedi|registrati|zaloguj|zarejestruj)`,
    // Cyrillic has no \b in a JS regex: whole stems instead.
    'увійти|увійдіть|вхід|зареєстр|реєстрац|створити (акаунт|обліковий)|продовжити з|войти|вход|зарегистр|регистрац|создать аккаунт|продолжить с',
  ].join('|'),
  'i',
);

export function isAccountControl(text: string): boolean {
  return ACCOUNT_CONTROL.test(text);
}

/** Identity providers' sign-in pages: host (and subdomains), and the paths that sign in. */
const IDENTITY_PAGES: Array<[string, RegExp]> = [
  ['github.com', /^\/(login|session|sessions\/)/],
  ['accounts.google.com', /^\//],
  ['appleid.apple.com', /^\//],
  ['idmsa.apple.com', /^\//],
  ['login.microsoftonline.com', /^\//],
  ['login.live.com', /^\//],
  ['linkedin.com', /^\/(login|uas\/|authwall|oauth\/)/],
  ['login.xing.com', /^\//],
  ['facebook.com', /^\/(login|dialog\/oauth)/],
];

/**
 * A site's own sign-in or sign-up page: /login, /signin, /users/sign_in, /login.ftl, … Not
 * "register": some ATSs call their application form a registration.
 */
const SIGN_IN_PATH = /\/(log-?in|sign-?in|sign_in|sign-?up|sign_up)(?=\/|\.|$)/i;

/** The page at `url` is a sign-in (or sign-up) page: an identity provider's or the site's own. */
export function isSignInPage(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (IDENTITY_PAGES.some(([h, path]) => onHost(host, h) && path.test(u.pathname))) return true;
  return SIGN_IN_PATH.test(u.pathname);
}

/**
 * Djinni's signed-out job page (runs in the page): its apply form is the anonymous one
 * (`anon_apply`), or the header offers Log In / Sign Up. Signed in, neither is there.
 */
function djinniSignedOut(): boolean {
  // Its value, not just the field: a signed-in page may well carry it as "false".
  const anon = document.querySelector<HTMLInputElement>('input[name="anon_apply"]');
  if (anon && !/^(false|0|)$/i.test(anon.value.trim())) return true;
  const links = document.querySelectorAll(
    'nav a.sign-in-link, nav a[href^="/login"], nav a[href^="/signup"]',
  );
  return [...links].some((a) => {
    const el = a as HTMLElement;
    return typeof el.checkVisibility === 'function'
      ? el.checkVisibility()
      : !!(el.offsetWidth || el.offsetHeight);
  });
}

const SIGNED_OUT: Record<SignInSiteKey, () => boolean> = { djinni: djinniSignedOut };

/**
 * Why the page asks the candidate to sign in, or null: it's a sign-in page, a sign-in site shows
 * its signed-out page, or the form asks for a password.
 */
export async function signInWall(page: Page): Promise<string | null> {
  const url = page.url();
  if (isSignInPage(url)) {
    const u = new URL(url);
    return `${u.hostname}${u.pathname} is a sign-in page`;
  }
  const site = signInSiteOf(url);
  if (site && (await page.evaluate(SIGNED_OUT[site.key]).catch(() => false))) {
    return `${site.name} shows its signed-out page`;
  }
  // A password among at most three other fields, as Read has it: a sign-in, not an application
  // form that also creates an account (that one is filled, and its password left to the
  // candidate).
  if (await asksSignIn(page).catch(() => false)) {
    const snap = await snapshotForm(page).catch(() => null);
    if (!snap || snap.fields.length <= 3) return 'the form asks for a password';
  }
  return null;
}

/**
 * Delivery stopped at a sign-in, before anything was sent. The app offers "Sign in to <host>"
 * on any note with "sign in" in it: keep the phrase.
 */
export function deliverySignInNote(url: string): string {
  const who = knownName(url) ?? 'The application page';
  return `${who} asks you to sign in before applying: nothing was sent. Sign in to ${siteHost(url)}, then approve again.`;
}

/** Read in the signed-in profile found the site signed out. */
export function readSignInNote(url: string): string {
  const who = knownName(url) ?? 'The application page';
  return `${who} asks you to sign in before applying: sign in to ${siteHost(url)}, and Applyant reads its form again`;
}

/** A note one of the above wrote. */
export function isSignInNote(note: string | null | undefined): boolean {
  return !!note && / asks you to sign in before applying: /.test(note);
}
