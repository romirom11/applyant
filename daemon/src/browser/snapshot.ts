// A form's fields, read from the live page across all frames.
//
//   1. every frame runs one DOM scan: fillable controls grouped into fields (radio and checkbox
//      groups, yes/no toggle buttons), each with its label, required flag and options; the
//      application form's root is the <form> holding most controls (else the page body)
//   2. the frame with the most form controls is the form's frame (cross-origin ATS iframes too)
//   3. each field's role and accessible name come from Playwright's ariaSnapshot, and its nth
//      from getByRole(role, { name, exact: true }): the ElementRef a fresh page can resolve.
//      Controls that aren't addressable that way (hidden file inputs, unnamed option groups)
//      get a CSS ref instead.
//
// Scanning marks elements with a data attribute for the Playwright calls and removes it after.
import type { Frame, FrameLocator, Locator, Page } from 'playwright';
import type { ElementRef, FieldKind, FieldSpec } from './form-types.ts';
import { refKey } from './form-types.ts';

const MARK = 'data-applyant-mark';

type AriaRole = Parameters<Page['getByRole']>[0];

/** What the scan knows about a field beyond the FieldSpec (for classification and filling). */
export interface FieldHint {
  /** input type, or the tag for select/textarea. */
  type: string;
  autocomplete: string;
  /** The name attribute. */
  name: string;
  placeholder: string;
  /** aria-describedby / help text. */
  description: string;
  /** Several options can be chosen (checkbox groups, multi-selects). */
  multiple: boolean;
  /** Option group made of toggle buttons (Ashby-style Yes / No). */
  toggle: boolean;
}

export interface SnapField extends FieldSpec {
  hint: FieldHint;
  /** The value the control shows now (text, chosen option, "checked"), or null. */
  value: string | null;
}

export interface SnapButton {
  ref: ElementRef;
  text: string;
  /** type=submit. */
  submit: boolean;
  /** Inside the form's root (rather than elsewhere in the frame). */
  inRoot: boolean;
}

export interface FormSnapshot {
  frame: Frame;
  framePath: string[];
  fields: SnapField[];
  buttons: SnapButton[];
  /** Visible validation messages. */
  errors: string[];
  /** Changes when controls appear or disappear (not when values change). */
  signature: string;
  /** The form asks for a password: a sign-in wall, not an application form. */
  signIn: boolean;
}

// ---- in-page scan -----------------------------------------------------------------------

interface ScanField {
  /** Element to ariaSnapshot for role + name; null = css only. */
  mark: string | null;
  css: string;
  /** For groups: the css selecting the options, used when the container has no name. */
  membersCss: string | null;
  kind: FieldKind;
  label: string;
  required: boolean;
  options: string[] | null;
  hint: FieldHint;
  value: string | null;
  group: boolean;
}

interface ScanButton {
  mark: string;
  css: string;
  text: string;
  submit: boolean;
  inRoot: boolean;
}

interface ScanResult {
  fields: ScanField[];
  buttons: ScanButton[];
  errors: string[];
  score: number;
  signature: string;
  signIn: boolean;
}

interface ScanArgs {
  attr: string;
  /** Only compute the signature (cheap, marks nothing). */
  signatureOnly: boolean;
}

/** Runs inside the page (serialised by Playwright): no closures over module scope. */
function scanFrame(args: ScanArgs): ScanResult {
  const d = document;
  const attr = args.attr;
  const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const shown = (el: Element): boolean => {
    const h = el as HTMLElement;
    if (typeof h.checkVisibility === 'function') {
      return h.checkVisibility({ visibilityProperty: true, opacityProperty: false });
    }
    return !!(h.offsetWidth || h.offsetHeight || h.getClientRects().length);
  };
  const SKIP_ZONE =
    '[role=search], #onetrust-consent-sdk, #CybotCookiebotDialog, [id*="cookie" i], [class*="cookie" i], [aria-label*="cookie" i]';
  const CONTROL =
    'input, select, textarea, [role=combobox], [role=textbox], [role=checkbox], [role=switch], [contenteditable="true"], [contenteditable=""]';
  const TEXT_TYPES = ['', 'text', 'email', 'tel', 'url', 'number'];

  const typeOf = (el: Element) => (el.getAttribute('type') ?? '').toLowerCase();
  const isInput = (el: Element, type?: string) =>
    el.tagName === 'INPUT' && (type === undefined || typeOf(el) === type);

  // Candidate controls, document order.
  let all = [...d.querySelectorAll(CONTROL)].filter((el) => {
    const type = typeOf(el);
    if (
      el.tagName === 'INPUT' &&
      ['hidden', 'submit', 'button', 'reset', 'image', 'search'].includes(type)
    )
      return false;
    if (el.closest(SKIP_ZONE)) return false;
    if ((el as HTMLInputElement).disabled) return false;
    const file = isInput(el, 'file');
    if (!shown(file ? (el.parentElement ?? el) : el)) return false;
    const choice = type === 'radio' || type === 'checkbox';
    if (!file && !choice) {
      if (el.getAttribute('aria-hidden') === 'true') return false;
      // Honeypots: text fields taken out of the tab order or pushed off-screen.
      if (
        el.tagName === 'INPUT' &&
        (el as HTMLElement).tabIndex < 0 &&
        el.getAttribute('role') !== 'combobox'
      )
        return false;
      // Positioned off the page itself (left: -9999px), not merely scrolled out of view.
      const r = el.getBoundingClientRect();
      if (r.right + window.scrollX < -500 || r.bottom + window.scrollY < -500) return false;
    }
    return true;
  });
  // A custom checkbox (div role=checkbox around a hidden input) is the control the page means:
  // keep it, not the input inside.
  const roleBoxes = all.filter(
    (el) => el.tagName !== 'INPUT' && /^(checkbox|switch)$/.test(el.getAttribute('role') ?? ''),
  );
  all = all.filter((el) => !(el.tagName === 'INPUT' && roleBoxes.some((b) => b.contains(el))));
  // A combobox wrapper around an input: keep the input.
  all = all.filter((el) => !all.some((other) => other !== el && el.contains(other)));
  // Passwords are never filled: a visible one means a sign-in (or sign-up) wall.
  const passwords = all.filter((el) => isInput(el, 'password'));
  all = all.filter((el) => !isInput(el, 'password'));

  // Yes / No style toggle buttons: a parent holding 2+ buttons that carry aria-pressed.
  const toggleParents = new Set<Element>();
  for (const b of d.querySelectorAll('button[aria-pressed], [role=button][aria-pressed]')) {
    const p = b.parentElement;
    if (!p || toggleParents.has(p) || p.closest(SKIP_ZONE) || !shown(p)) continue;
    const siblings = [...p.children].filter((c) => c.hasAttribute('aria-pressed'));
    if (siblings.length >= 2 && siblings.every((c) => norm(c.textContent).length <= 40))
      toggleParents.add(p);
  }
  // Their hidden companion inputs are not fields of their own.
  all = all.filter((el) => ![...toggleParents].some((p) => p.contains(el)));

  // The application form: the <form> holding most controls, else the whole page.
  const controlsIn = (root: Element) =>
    all.filter((c) => root.contains(c)).length +
    [...toggleParents].filter((p) => root.contains(p)).length;
  const total = all.length + toggleParents.size;
  let root: Element = d.body;
  let best = 0;
  for (const f of d.querySelectorAll('form')) {
    const n = controlsIn(f);
    if (n > best) {
      best = n;
      root = f;
    }
  }
  if (best < 2 || best < total * 0.6) root = d.body;
  const inRoot = (el: Element) => root === d.body || root.contains(el);
  const controls = all.filter(inRoot);
  const toggles = [...toggleParents].filter(inRoot);
  const hasEmailOrFile = controls.some(
    (c) => isInput(c, 'email') || isInput(c, 'file') || /mail/i.test(c.getAttribute('name') ?? ''),
  );
  const score = controls.length + toggles.length + (hasEmailOrFile ? 3 : 0);

  const signature = [
    ...controls.map((c) => `${c.tagName}:${typeOf(c)}:${c.getAttribute('name') ?? ''}:${c.id}`),
    ...toggles.map((t) => `toggle:${t.children.length}`),
  ].join('|');
  const signIn = passwords.some(inRoot);
  if (args.signatureOnly) return { fields: [], buttons: [], errors: [], score, signature, signIn };

  for (const el of d.querySelectorAll(`[${attr}]`)) el.removeAttribute(attr);
  let seq = 0;
  const mark = (el: Element): string => {
    const v = String(seq++);
    el.setAttribute(attr, v);
    return v;
  };

  const attrEsc = (s: string) => s.replace(/["\\]/g, '\\$&');
  const unique = (sel: string) => {
    try {
      return d.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  };
  // Ids and names generated per page load (UUIDs, React useId) would not find the element
  // on the next load: structural paths are steadier for those.
  const steady = (v: string | null): v is string =>
    !!v &&
    !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(v) &&
    !/^:r[0-9a-z]*:$|^react-select-\d/.test(v) &&
    // A long mixed-case alphanumeric run ("input_files_input_Pet31Ww9bdOsudi4") is a nonce.
    !(v.match(/[A-Za-z0-9]{12,}/g) ?? []).some(
      (run) => /\d/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run),
    );
  const cssFor = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    if (steady(el.id) && unique(`#${CSS.escape(el.id)}`)) return `#${CSS.escape(el.id)}`;
    const name = el.getAttribute('name');
    if (steady(name) && unique(`${tag}[name="${attrEsc(name)}"]`))
      return `${tag}[name="${attrEsc(name)}"]`;
    // The parent of a uniquely named child (e.g. a toggle group's hidden input).
    for (const child of el.children) {
      const n = child.getAttribute('name');
      if (steady(n) && unique(`[name="${attrEsc(n)}"]`))
        return `${tag}:has(> [name="${attrEsc(n)}"])`;
    }
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== d.body && cur !== d.documentElement) {
      const t = cur.tagName.toLowerCase();
      if (cur !== el && steady(cur.id) && unique(`#${CSS.escape(cur.id)}`)) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        return parts.join(' > ');
      }
      const parent: Element | null = cur.parentElement;
      const same = parent ? [...parent.children].filter((c) => c.tagName === cur?.tagName) : [];
      parts.unshift(same.length > 1 ? `${t}:nth-of-type(${same.indexOf(cur) + 1})` : t);
      cur = parent;
    }
    parts.unshift('body');
    return parts.join(' > ');
  };

  /** Rendered text of an element without the text of controls and hidden decorations inside it. */
  const SKIP_TEXT =
    'input, select, textarea, button, svg, script, style, [aria-hidden="true"], [role=listbox], [role=option], [role=combobox], [role=button]';
  const textOf = (el: Element): string => {
    let t = (el as HTMLElement).innerText ?? el.textContent ?? '';
    for (const inner of el.querySelectorAll(SKIP_TEXT)) {
      const outer = inner.parentElement?.closest(SKIP_TEXT);
      if (outer && el.contains(outer)) continue;
      const text = (inner as HTMLElement).innerText ?? inner.textContent ?? '';
      if (text) t = t.replace(text, ' ');
    }
    return norm(t);
  };
  const hasControl = (el: Element) =>
    el.matches(`${CONTROL}, button`) || !!el.querySelector(`${CONTROL}, button`);
  /** A "*" drawn by CSS (::before / ::after), the way custom controls often mark required. */
  const pseudoStar = (el: Element | null): boolean =>
    !!el && ['::before', '::after'].some((pe) => /[*✱]/.test(getComputedStyle(el, pe).content));
  const starred = (el: Element | null): boolean => {
    if (!el) return false;
    if (/[*✱]/.test(el.textContent ?? '')) return true;
    if (/required/i.test(typeof el.className === 'string' ? el.className : '')) return true;
    return pseudoStar(el);
  };
  const cleanLabel = (s: string) =>
    norm(s)
      .replace(/\s*[*✱]+\s*$/, '')
      .replace(/\s*\((required|optional)\)\s*$/i, '')
      .replace(/^[*✱]\s*/, '')
      .trim();
  const byIds = (ids: string | null) =>
    norm(
      (ids ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => {
          const e = d.getElementById(id);
          return e ? textOf(e) : '';
        })
        .join(' '),
    );

  interface Found {
    text: string;
    node: Element | null;
  }
  const LABEL_TAGS = 'label, legend';
  const LABEL_CLASSES = '[class*="label" i], [class*="title" i], [class*="question" i]';
  /** The question text before `el`: its previous siblings, climbing a few levels. */
  const precedingText = (el: Element): Found | null => {
    let node: Element | null = el;
    for (let depth = 0; node && node !== root.parentElement && depth < 5; depth++) {
      const texts: Array<{ text: string; node: Element; rank: number }> = [];
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (hasControl(sib)) break;
        const text = textOf(sib);
        if (!text || text.length > 400) continue;
        const rank =
          sib.matches(LABEL_TAGS) || sib.querySelector(LABEL_TAGS)
            ? 0
            : sib.matches(LABEL_CLASSES)
              ? 1
              : 2;
        texts.push({ text, node: sib, rank });
      }
      if (texts.length) {
        texts.sort((a, b) => a.rank - b.rank);
        const top = texts[0];
        if (top) return { text: top.text, node: top.node };
      }
      node = node.parentElement;
    }
    return null;
  };
  /** The text a container starts with, before its first control (a fieldset's label). */
  const leadingText = (container: Element): Found | null => {
    const legend = container.querySelector(':scope > legend');
    if (legend && textOf(legend)) return { text: textOf(legend), node: legend };
    for (const child of container.children) {
      if (hasControl(child)) break;
      const text = textOf(child);
      if (text && text.length <= 400) return { text, node: child };
    }
    return null;
  };

  const labelOf = (el: Element): Found => {
    const labelledBy = byIds(el.getAttribute('aria-labelledby'));
    if (labelledBy) {
      const first = d.getElementById(
        (el.getAttribute('aria-labelledby') ?? '').split(/\s+/)[0] ?? '',
      );
      return { text: labelledBy, node: first };
    }
    const labels = (el as HTMLInputElement).labels;
    if (labels?.length) {
      const l = labels[0] as HTMLLabelElement;
      const t = textOf(l);
      if (t) return { text: t, node: l };
    }
    const wrap = el.closest('label');
    if (wrap && textOf(wrap)) return { text: textOf(wrap), node: wrap };
    const aria = norm(el.getAttribute('aria-label'));
    if (aria) return { text: aria, node: null };
    const before = precedingText(
      el.parentElement && el.parentElement.children.length === 1 ? el.parentElement : el,
    );
    if (before) return before;
    const ph = norm(
      el.getAttribute('placeholder') ?? el.getAttribute('title') ?? el.getAttribute('name'),
    );
    return { text: ph, node: null };
  };
  const describedBy = (el: Element) => byIds(el.getAttribute('aria-describedby')).slice(0, 300);
  const requiredOf = (el: Element, label: Found) =>
    (el as HTMLInputElement).required ||
    el.getAttribute('aria-required') === 'true' ||
    starred(label.node) ||
    pseudoStar(el) ||
    /[*✱]\s*$/.test(norm(el.getAttribute('aria-label')));
  const PLACEHOLDER_OPTION = /^(select|choose|please (select|choose)|--|—|-|\.\.\.)\b/i;
  const optionLabel = (el: Element, groupLabel: string): string => {
    let t = '';
    const labels = (el as HTMLInputElement).labels;
    if (labels?.length) t = textOf(labels[0] as Element);
    if (!t && el.closest('label')) t = textOf(el.closest('label') as Element);
    if (!t) t = norm(el.getAttribute('aria-label'));
    if (!t && el.nextElementSibling) t = textOf(el.nextElementSibling);
    if (!t) t = norm(el.nextSibling?.textContent);
    if (!t) t = norm(el.getAttribute('value'));
    if (groupLabel && t.startsWith(groupLabel) && t.length > groupLabel.length)
      t = t.slice(groupLabel.length).trim();
    return t.slice(0, 200);
  };
  const commonAncestor = (els: Element[]): Element => {
    let c: Element = els[0]?.parentElement ?? d.body;
    while (c !== d.body && !els.every((e) => c.contains(e))) c = c.parentElement ?? d.body;
    return c;
  };
  const hintOf = (el: Element, multiple = false, toggle = false): FieldHint => ({
    type: el.tagName === 'INPUT' ? typeOf(el) || 'text' : el.tagName.toLowerCase(),
    autocomplete: norm(el.getAttribute('autocomplete')),
    name: el.getAttribute('name') ?? '',
    placeholder: norm(el.getAttribute('placeholder')),
    description: describedBy(el),
    multiple,
    toggle,
  });

  // Group radios and checkboxes that belong to one question.
  const groupOf = new Map<Element, Element[]>();
  const choices = controls.filter((c) => isInput(c, 'radio') || isInput(c, 'checkbox'));
  const byKey = new Map<string, Element[]>();
  for (const c of choices) {
    const type = typeOf(c);
    const name = c.getAttribute('name');
    const box = c.closest('fieldset, [role=radiogroup], [role=group]');
    let key: string;
    if (type === 'radio' && name) key = `radio:name:${name}`;
    else if (box && box.querySelectorAll(`input[type=${type}]`).length > 1)
      key = `${type}:box:${cssFor(box)}`;
    else if (name && choices.filter((o) => o.getAttribute('name') === name).length > 1)
      key = `${type}:name:${name}`;
    else {
      const list = c.closest('ul, ol');
      key =
        list && list.querySelectorAll(`input[type=${type}]`).length > 1
          ? `${type}:list:${cssFor(list)}`
          : `${type}:single:${cssFor(c)}`;
    }
    const members = byKey.get(key) ?? [];
    members.push(c);
    byKey.set(key, members);
  }
  for (const members of byKey.values()) for (const m of members) groupOf.set(m, members);

  // Repeatable sections ("Education (Optional)  + Add"): an add control that opens an entry.
  const ADD = /^\+?\s*add\b/i;
  const addButtons = new Set(
    [...root.querySelectorAll('button, [role=button]')].filter((b) => {
      if (b.closest(SKIP_ZONE) || !shown(b) || [...toggleParents].some((t) => t.contains(b)))
        return false;
      const name = norm(b.getAttribute('aria-label') || (b as HTMLElement).innerText);
      return ADD.test(name) && name.length <= 60;
    }),
  );

  const fields: ScanField[] = [];
  const emitted = new Set<Element[]>();
  const items: Element[] = [...controls, ...toggles, ...addButtons].sort((a, b) =>
    a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );

  for (const el of items) {
    if (addButtons.has(el)) {
      const name = norm(el.getAttribute('aria-label') || (el as HTMLElement).innerText);
      const named = name.replace(/^\+?\s*add\s+(another\s+|an?\s+|more\s+|new\s+)?/i, '');
      const around = el.parentElement ?? el;
      const heading = leadingText(around) ?? precedingText(el) ?? { text: '', node: null };
      const text = named && !ADD.test(named) && named !== name ? named : heading.text;
      fields.push({
        mark: mark(el),
        css: cssFor(el),
        membersCss: null,
        kind: 'group',
        label: cleanLabel(text),
        required:
          !/\(optional\)/i.test(textOf(around)) &&
          (starred(heading.node) || el.getAttribute('aria-required') === 'true'),
        options: null,
        hint: hintOf(el),
        value: null,
        group: false,
      });
      continue;
    }
    if (toggleParents.has(el)) {
      const buttons = [...el.children].filter((c) => c.hasAttribute('aria-pressed'));
      const label = leadingText(el) ?? precedingText(el) ?? { text: '', node: null };
      const css = cssFor(el);
      fields.push({
        mark: null,
        css,
        membersCss: `${css} > [aria-pressed]`,
        kind: 'radio',
        label: cleanLabel(label.text),
        required: starred(label.node) || el.getAttribute('aria-required') === 'true',
        options: buttons.map((b) => norm(b.textContent)),
        hint: hintOf(el, false, true),
        value:
          norm(buttons.find((b) => b.getAttribute('aria-pressed') === 'true')?.textContent) || null,
        group: true,
      });
      continue;
    }
    const members = groupOf.get(el);
    if (members && members.length > 1) {
      if (emitted.has(members)) continue;
      emitted.add(members);
      const type = typeOf(el);
      const container = commonAncestor(members);
      // A fieldset / radiogroup holding exactly this group is addressable by role and name.
      const box = container.closest('fieldset, [role=radiogroup], [role=group]');
      const holder =
        box &&
        box.querySelectorAll('input[type=radio], input[type=checkbox]').length === members.length
          ? box
          : null;
      const label = (holder?.getAttribute('aria-labelledby') && {
        text: byIds(holder.getAttribute('aria-labelledby')),
        node: d.getElementById(holder.getAttribute('aria-labelledby') ?? ''),
      }) ||
        (holder?.getAttribute('aria-label') && {
          text: norm(holder.getAttribute('aria-label')),
          node: null,
        }) ||
        leadingText(holder ?? container) ||
        precedingText(holder ?? container) || { text: '', node: null };
      const groupLabel = cleanLabel(label.text);
      const name = el.getAttribute('name');
      const sharedName = steady(name) && members.every((m) => m.getAttribute('name') === name);
      const membersCss = sharedName
        ? `input[type="${type}"][name="${attrEsc(name ?? '')}"]`
        : `${cssFor(container)} input[type="${type}"]`;
      fields.push({
        mark: holder ? mark(holder) : null,
        css: cssFor(container),
        membersCss,
        kind: type === 'radio' ? 'radio' : 'checkbox',
        label: groupLabel,
        required:
          members.some(
            (m) => (m as HTMLInputElement).required || m.getAttribute('aria-required') === 'true',
          ) ||
          container.getAttribute('aria-required') === 'true' ||
          starred(label.node),
        options: members.map((m) => optionLabel(m, groupLabel)),
        hint: hintOf(el, type === 'checkbox'),
        value:
          members
            .filter((m) => (m as HTMLInputElement).checked)
            .map((m) => optionLabel(m, groupLabel))
            .join(', ') || null,
        group: true,
      });
      continue;
    }

    const type = typeOf(el);
    const label = labelOf(el);
    let kind: FieldKind = 'text';
    let options: string[] | null = null;
    let multiple = false;
    let value: string | null = null;
    if (el.tagName === 'SELECT') {
      const sel = el as HTMLSelectElement;
      kind = 'select';
      multiple = sel.multiple;
      options = [...sel.options]
        .filter(
          (o) => !(o.value === '' && (PLACEHOLDER_OPTION.test(norm(o.text)) || !norm(o.text))),
        )
        .filter((o) => !PLACEHOLDER_OPTION.test(norm(o.text)) || o.value !== '')
        .map((o) => norm(o.text));
      const chosen = sel.selectedOptions[0];
      value = chosen && chosen.value !== '' ? norm(chosen.text) : null;
    } else if (
      el.tagName === 'TEXTAREA' ||
      el.getAttribute('contenteditable') !== null ||
      el.getAttribute('role') === 'textbox'
    ) {
      kind = 'textarea';
      value = norm((el as HTMLTextAreaElement).value ?? el.textContent) || null;
    } else if (type === 'file') {
      kind = 'file';
      multiple = (el as HTMLInputElement).multiple;
    } else if (['date', 'month', 'datetime-local', 'week'].includes(type)) {
      kind = 'date';
      value = (el as HTMLInputElement).value || null;
    } else if (type === 'checkbox' || roleBoxes.includes(el)) {
      kind = 'checkbox';
      value =
        (el as HTMLInputElement).checked || el.getAttribute('aria-checked') === 'true'
          ? 'checked'
          : null;
    } else if (type === 'radio') {
      kind = 'radio';
      options = [optionLabel(el, '')];
    } else if (el.getAttribute('role') === 'combobox' || el.closest('[role=combobox]')) {
      kind = 'combobox';
      value = (el as HTMLInputElement).value || null;
    } else if (TEXT_TYPES.includes(type)) {
      kind = 'text';
      value = (el as HTMLInputElement).value || null;
    } else {
      kind = 'unknown';
    }
    // File inputs are usually hidden behind a button: label them from their field container.
    let fieldLabel = label;
    if (kind === 'file') {
      // "Autofill from resume" uploads parse the file on the ATS's servers: not a question.
      const around = textOf(el.parentElement?.parentElement ?? el).slice(0, 400);
      if (/autofill|auto-fill|parse your|import (your )?(resume|cv|profile)/i.test(around))
        continue;
      // Its own label, unless that only names the button ("Attach", "Upload file")…
      const generic = (t: string) => !t || /^(attach|upload|choose|select|browse|drop)/i.test(t);
      const group = el.closest('[role=group][aria-labelledby]');
      fieldLabel =
        (group && {
          text: byIds(group.getAttribute('aria-labelledby')),
          node: d.getElementById(group.getAttribute('aria-labelledby') ?? ''),
        }) ||
        (!generic(label.text) && label.node ? label : null) ||
        // …else the text before its container (the field's heading).
        precedingText(el.closest('div') ?? el) ||
        label;
      if (generic(fieldLabel.text)) {
        fieldLabel = precedingText(el.closest('div')?.parentElement ?? el) ?? fieldLabel;
      }
    }
    let text = cleanLabel(fieldLabel.text);
    if (kind === 'file') {
      // "Resume/CV ATTACH RESUME/CV", "Resume Choose file": drop the button's caption.
      const trimmed = text
        .replace(/\s+(attach|upload|choose|select|browse|drop)\b.*$/i, '')
        .replace(/[\s*✱]+$/, '');
      if (trimmed) text = trimmed;
    }
    fields.push({
      mark: kind === 'file' ? null : mark(el),
      css: cssFor(el),
      membersCss: null,
      kind,
      label: text,
      required:
        requiredOf(el, fieldLabel) ||
        (kind === 'file' && el.closest('[aria-required="true"]') !== null),
      options,
      hint: hintOf(el, multiple),
      value,
      group: false,
    });
  }

  // Shortcuts that aren't questions ("Autofill from resume", "Apply with LinkedIn").
  const kept = fields.filter(
    (f) => !/autofill|auto-fill|apply with|import (your )?(resume|cv|profile)/i.test(f.label),
  );

  const toggleButtons = new Set([...toggles.flatMap((t) => [...t.children]), ...addButtons]);
  const buttons: ScanButton[] = [];
  for (const b of d.querySelectorAll(
    'button, input[type=submit], input[type=button], [role=button], a[role=button]',
  )) {
    if (toggleButtons.has(b) || b.closest(SKIP_ZONE) || !shown(b)) continue;
    if ((b as HTMLButtonElement).disabled) continue;
    const text = norm(
      b.getAttribute('aria-label') ||
        (b as HTMLElement).innerText ||
        (b as HTMLInputElement).value ||
        b.getAttribute('title'),
    );
    if (!text || text.length > 80) continue;
    buttons.push({
      mark: mark(b),
      css: cssFor(b),
      text,
      submit:
        (b.tagName === 'BUTTON' && (b as HTMLButtonElement).type === 'submit') ||
        isInput(b, 'submit'),
      inRoot: inRoot(b),
    });
  }

  // Alerts anywhere in the frame (wizards show "Errors Found" above the form); error styling
  // only inside the form.
  const errors: string[] = [];
  const errorNodes = [
    ...d.querySelectorAll('[role=alert], [aria-live=assertive]'),
    ...root.querySelectorAll('[class*="error" i], [class*="invalid" i]'),
  ];
  for (const e of errorNodes) {
    if (!shown(e)) continue;
    const t = norm((e as HTMLElement).innerText);
    if (t && t.length <= 200 && !errors.includes(t)) errors.push(t);
    if (errors.length >= 10) break;
  }

  return { fields: kept, buttons, errors, score, signature, signIn };
}

// ---- Node side --------------------------------------------------------------------------

const SKIP_FRAME_HOSTS =
  /(^|\.)(recaptcha\.net|hcaptcha\.com|challenges\.cloudflare\.com|googletagmanager\.com|doubleclick\.net|google-analytics\.com|facebook\.com|youtube\.com|vimeo\.com)$/;

function usableFrame(frame: Frame): boolean {
  if (frame.isDetached()) return false;
  const url = frame.url();
  try {
    const u = new URL(url);
    if (SKIP_FRAME_HOSTS.test(u.hostname)) return false;
    if (u.hostname.endsWith('google.com') && u.pathname.startsWith('/recaptcha')) return false;
  } catch {
    // about:blank / srcdoc frames are scanned: a form can live there too.
  }
  return true;
}

/** The iframe selectors from the top page down to `frame`. */
export async function framePathOf(frame: Frame): Promise<string[]> {
  const path: string[] = [];
  for (let f: Frame | null = frame; f?.parentFrame(); f = f.parentFrame()) {
    const el = await f.frameElement();
    const sel = await el.evaluate((n) => {
      const node = n as Element;
      const esc = (s: string) => s.replace(/["\\]/g, '\\$&');
      const doc = node.ownerDocument;
      const all = [...doc.querySelectorAll('iframe, frame')];
      const tag = node.tagName.toLowerCase();
      const tries: string[] = [];
      if (node.id) tries.push(`${tag}#${CSS.escape(node.id)}`);
      const name = node.getAttribute('name');
      if (name) tries.push(`${tag}[name="${esc(name)}"]`);
      const title = node.getAttribute('title');
      if (title) tries.push(`${tag}[title="${esc(title)}"]`);
      const src = node.getAttribute('src');
      if (src) tries.push(`${tag}[src="${esc(src)}"]`);
      for (const t of tries) if (doc.querySelectorAll(t).length === 1) return t;
      return `${tag} >> nth=${all.indexOf(node)}`;
    });
    await el.dispose();
    path.unshift(sel);
  }
  return path;
}

export function frameRoot(page: Page, path: string[]): Page | FrameLocator {
  let root: Page | FrameLocator = page;
  for (const sel of path) root = root.frameLocator(sel);
  return root;
}

/**
 * The element a ref points at. For option groups with a css ref this is the list of options
 * (use `.nth(i)`); for a group container ref, the container.
 */
export function locate(page: Page, ref: ElementRef): Locator {
  const root = frameRoot(page, ref.frame);
  if (ref.css) return root.locator(ref.css);
  return root.getByRole(ref.role as AriaRole, { name: ref.name, exact: true }).nth(ref.nth);
}

/** "- textbox "Email": x" → { role: textbox, name: Email }. */
export function parseAriaLine(snapshot: string): { role: string; name: string } | null {
  const line = snapshot.split('\n')[0] ?? '';
  const m = /^- ([a-z]+)(?: ("(?:[^"\\]|\\.)*"))?/.exec(line.trim());
  if (!m?.[1]) return null;
  let name = '';
  if (m[2]) {
    try {
      name = JSON.parse(m[2]) as string;
    } catch {
      name = m[2].slice(1, -1);
    }
  }
  return { role: m[1], name };
}

async function scanAll(page: Page): Promise<Array<{ frame: Frame; result: ScanResult }>> {
  const out: Array<{ frame: Frame; result: ScanResult }> = [];
  for (const frame of page.frames()) {
    if (!usableFrame(frame)) continue;
    const result = await frame
      .evaluate(scanFrame, { attr: MARK, signatureOnly: false })
      .catch(() => null);
    if (result) out.push({ frame, result });
  }
  return out;
}

async function clearMarks(frames: Frame[]): Promise<void> {
  for (const f of frames) {
    await f
      .evaluate((attr) => {
        for (const el of document.querySelectorAll(`[${attr}]`)) el.removeAttribute(attr);
      }, MARK)
      .catch(() => {});
  }
}

/** Role + name + nth for a marked element, or null when getByRole can't single it out. */
/** Generous: only a loaded machine gets anywhere near it (see roleRef). */
const ROLE_REF_MS = 30_000;

async function roleRef(
  frame: Frame,
  mark: string,
  nthCache: Map<string, Array<string | null>>,
): Promise<{ role: string; name: string; nth: number } | null> {
  // The ref is the field's identity from Read to Deliver, so it mustn't depend on how busy the
  // machine is. The marked element is either gone (then no role ref, at once) or there, and then
  // its snapshot only needs CPU: a short timeout here turned role refs into CSS refs under load,
  // Deliver no longer recognised the fields Read had recorded, and handed them off as missing.
  const el = frame.locator(`[${MARK}="${mark}"]`);
  if ((await el.count().catch(() => 0)) === 0) return null;
  const snap = await el.ariaSnapshot({ timeout: ROLE_REF_MS }).catch(() => '');
  const parsed = parseAriaLine(snap);
  if (!parsed?.name || parsed.role === 'generic' || parsed.role === 'text') return null;
  const key = `${parsed.role}\u0000${parsed.name}`;
  let marks = nthCache.get(key);
  if (!marks) {
    marks = await frame
      .getByRole(parsed.role as AriaRole, { name: parsed.name, exact: true })
      .evaluateAll((els, attr) => els.map((e) => e.getAttribute(attr)), MARK)
      .catch(() => [] as Array<string | null>);
    nthCache.set(key, marks);
  }
  const nth = marks.indexOf(mark);
  return nth < 0 ? null : { role: parsed.role, name: parsed.name, nth };
}

const MEMBER_ROLE: Partial<Record<FieldKind, string>> = { radio: 'radio', checkbox: 'checkbox' };
const FALLBACK_ROLE: Partial<Record<FieldKind, string>> = {
  file: 'button',
  group: 'button',
  checkbox: 'checkbox',
  radio: 'radio',
  select: 'combobox',
  combobox: 'combobox',
};

/** Reads the application form on the page, or null when no frame has form controls. */
export async function snapshotForm(page: Page): Promise<FormSnapshot | null> {
  const scans = await scanAll(page);
  try {
    let best: { frame: Frame; result: ScanResult } | null = null;
    for (const s of scans) {
      if (s.result.fields.length === 0) continue;
      if (!best || s.result.score > best.result.score) best = s;
    }
    if (!best) return null;
    const { frame, result } = best;
    const framePath = await framePathOf(frame);
    const nthCache = new Map<string, Array<string | null>>();

    const fields: SnapField[] = [];
    for (const f of result.fields) {
      let ref: ElementRef | null = null;
      if (f.mark !== null) {
        const r = await roleRef(frame, f.mark, nthCache);
        if (r) ref = { frame: framePath, ...r, css: null };
      }
      if (!ref) {
        ref = {
          frame: framePath,
          role: f.group ? (MEMBER_ROLE[f.kind] ?? 'button') : (FALLBACK_ROLE[f.kind] ?? 'textbox'),
          name: f.label,
          nth: 0,
          css: f.membersCss ?? f.css,
        };
      }
      fields.push({
        ref,
        label: f.label,
        kind: f.kind,
        required: f.required,
        options: f.options,
        meaning: null,
        revealedBy: null,
        hint: f.hint,
        value: f.value,
      });
    }
    const buttons: SnapButton[] = [];
    for (const b of result.buttons) {
      const r = await roleRef(frame, b.mark, nthCache);
      buttons.push({
        ref: r
          ? { frame: framePath, ...r, css: null }
          : { frame: framePath, role: 'button', name: b.text, nth: 0, css: b.css },
        text: b.text,
        submit: b.submit,
        inRoot: b.inRoot,
      });
    }
    return {
      frame,
      framePath,
      fields: dedupe(fields),
      buttons,
      errors: result.errors,
      signature: result.signature,
      signIn: result.signIn,
    };
  } finally {
    await clearMarks(scans.map((s) => s.frame));
  }
}

function dedupe(fields: SnapField[]): SnapField[] {
  const seen = new Set<string>();
  return fields.filter((f) => {
    const k = refKey(f.ref);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The controls signature of the best form frame (cheap: no marks, no Playwright calls per field). */
export async function formSignature(page: Page): Promise<string> {
  let best = { score: -1, signature: '' };
  for (const frame of page.frames()) {
    if (!usableFrame(frame)) continue;
    const r = await frame
      .evaluate(scanFrame, { attr: MARK, signatureOnly: true })
      .catch(() => null);
    if (r && r.score > best.score)
      best = { score: r.score, signature: signatureOf(frame.url(), r.signature) };
  }
  return best.signature;
}

/** Whether any frame shows a password field inside a form: a sign-in wall. */
export async function asksSignIn(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    if (!usableFrame(frame)) continue;
    const r = await frame
      .evaluate(scanFrame, { attr: MARK, signatureOnly: true })
      .catch(() => null);
    if (r?.signIn) return true;
  }
  return false;
}

/** Between the frame's URL and its controls in a signature (a URL may itself hold a `#`). */
const SIGNATURE_SEP = '\n';

/** A frame's controls as `formSignature` reports them (what a snapshot compares against). */
export function signatureOf(frameUrl: string, controls: string): string {
  return `${frameUrl}${SIGNATURE_SEP}${controls}`;
}

/** Whether a `formSignature` saw any form controls at all. */
export function signatureHasControls(signature: string): boolean {
  const at = signature.indexOf(SIGNATURE_SEP);
  return at >= 0 && signature.slice(at + SIGNATURE_SEP.length) !== '';
}
