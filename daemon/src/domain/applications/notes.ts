// The candidate's own notes and company contacts on an application (PRD: "the email is kept in
// the application's history, along with company contacts and the candidate's notes").
import { asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { type ApplicationContactRow, applicationContacts, applications } from '../../db/schema.ts';
import { ApplicationError } from './store.ts';

export interface ContactInput {
  name?: string | null;
  role?: string | null;
  email?: string | null;
  linkedin?: string | null;
  note?: string | null;
}

const clean = (v: string | null | undefined): string | null => v?.trim() || null;

function appExists(db: Db, appId: number): void {
  const row = db
    .select({ id: applications.id })
    .from(applications)
    .where(eq(applications.id, appId))
    .get();
  if (!row) throw new ApplicationError(`no application ${appId}`);
}

export function setApplicationNotes(db: Db, appId: number, notes: string, now: Date): void {
  appExists(db, appId);
  db.update(applications)
    .set({ notes: clean(notes), updatedAt: now })
    .where(eq(applications.id, appId))
    .run();
}

export function addApplicationContact(
  db: Db,
  appId: number,
  input: ContactInput,
  now: Date,
): ApplicationContactRow {
  appExists(db, appId);
  const email = clean(input.email);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApplicationError(`"${email}" isn't an email address`);
  }
  let linkedin = clean(input.linkedin);
  if (linkedin && !/^https?:\/\//i.test(linkedin)) linkedin = `https://${linkedin}`;
  if (linkedin && !/^https?:\/\/([a-z0-9-]+\.)*linkedin\.com\//i.test(linkedin)) {
    throw new ApplicationError(`"${input.linkedin}" isn't a LinkedIn link`);
  }
  const name = clean(input.name);
  if (!name && !email && !linkedin) {
    throw new ApplicationError('a contact needs a name, an email or a LinkedIn link');
  }
  return db
    .insert(applicationContacts)
    .values({
      applicationId: appId,
      name,
      role: clean(input.role),
      email,
      linkedin,
      note: clean(input.note),
      createdAt: now,
    })
    .returning()
    .get();
}

/** Removes a contact; returns the application it was on. */
export function deleteApplicationContact(db: Db, contactId: number): number {
  const row = db
    .select()
    .from(applicationContacts)
    .where(eq(applicationContacts.id, contactId))
    .get();
  if (!row) throw new ApplicationError(`no contact ${contactId}`);
  db.delete(applicationContacts).where(eq(applicationContacts.id, contactId)).run();
  return row.applicationId;
}

export function contactsFor(db: Db, appId: number): ApplicationContactRow[] {
  return db
    .select()
    .from(applicationContacts)
    .where(eq(applicationContacts.applicationId, appId))
    .orderBy(asc(applicationContacts.createdAt), asc(applicationContacts.id))
    .all();
}
