// The posting text the extractor reads. Readability picks one block as "the article"; on a
// job page built from sibling sections (Lever: the company's introduction, then "What you'll
// do", "What we're looking for") it can keep the introduction and drop the rest, which left
// postings with no requirements at all and a score from the title alone.
import { describe, expect, it } from 'vitest';
import { htmlToText, wholePageText } from '../src/domain/knowledge/text/html.ts';

const section = (title: string, items: string[]) =>
  `<div class="section page-centered"><div><h3>${title}</h3><div class="posting-requirements plain-list"><ul>${items
    .map((i) => `<li>${i}</li>`)
    .join('')}</ul></div></div></div>`;

const PAGE = `<!doctype html><html><head><title>Acme - Senior Python Engineer</title></head><body>
<nav><a href="/">Acme jobs</a><a href="/all">All openings</a></nav>
<div class="content">
  <div class="section page-centered" data-qa="job-description">
    ${Array.from({ length: 6 }, (_, i) => `<p>Acme is the arena for high-upside play, paragraph ${i + 1}. We are dismantling the paywalls of legacy products and reimagining the economics of games to pioneer the next generation of rewards-driven entertainment.</p>`).join('\n')}
  </div>
  ${section("What You'll Do", ['Design and maintain backend services in Python and Django', 'Build integrations with KYC, geolocation and payment partners'])}
  ${section("What We're Looking For", ['5+ years of backend experience with Python', 'Production experience with PostgreSQL'])}
  ${section('Nice To Have', ['Experience with Kafka'])}
</div>
<form><label>Email <input name="email"></label><button>Subscribe</button></form>
<footer>Jobs powered by Lever</footer>
</body></html>`;

describe('the whole page as text', () => {
  it('keeps every section in order, with headings and list items, and leaves the furniture out', () => {
    const { title, text } = wholePageText(PAGE);
    expect(title).toBe('Acme - Senior Python Engineer');
    expect(text).toContain(
      "#### What We're Looking For\n\n- 5+ years of backend experience with Python",
    );
    expect(text.indexOf("What You'll Do")).toBeLessThan(text.indexOf('Nice To Have'));
    expect(text).toContain('- Experience with Kafka');
    expect(text).not.toMatch(/All openings|Subscribe|powered by Lever/);
  });

  it('is at least as complete as the readable text, so a dropped section shows as a shortfall', () => {
    const readable = htmlToText(PAGE, 'https://jobs.example.com/acme/1').text;
    const whole = wholePageText(PAGE).text;
    expect(whole.length).toBeGreaterThanOrEqual(readable.length);
    expect(whole).toContain('Production experience with PostgreSQL');
  });
});
