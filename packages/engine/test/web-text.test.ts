import { describe, expect, test } from "bun:test";
import { decodeEntities, htmlToText, linkLines } from "../src/tools/web-text.ts";

const text = (html: string, base = "https://docs.example.com/guide/") => htmlToText(html, base);

describe("readable text from a web page, with nothing installed", () => {
  test("the main content only: navigation, header, footer, aside, forms, scripts, styles, hidden things and comments are not read", () => {
    const r = text(`<html><head><title>T</title><style>p{}</style></head><body><nav>Menu</nav><header>Banner</header><main><p>Kept</p><div hidden>no</div><span aria-hidden="true">no</span><p style="display: none">no</p><script>var secret = 1</script><!-- no --><form><input></form><aside>Side</aside></main><footer>Foot</footer></body></html>`);
    expect(r.text).toBe("Kept");
    expect(r.title).toBe("T");
  });

  test("with no main, an article is taken; with neither, the body", () => {
    expect(text("<body><nav>x</nav><div><article><p>In article</p></article><p>Outside</p></div></body>").text).toBe("In article");
    expect(text("<body><p>Only body</p><nav>nav</nav></body>").text).toBe("Only body");
    expect(text("<p>No body tag at all</p>").text).toBe("No body tag at all");
  });

  test("headings, nested lists, ordered lists, inline code, code blocks that keep their spaces, tables as rows, quotes, images by their words", () => {
    const r = text(`<main><h2>Setup</h2><p>Use <code>bun i</code>.</p><ul><li>a<ul><li>b</li></ul></li><li>c</li></ul><ol><li>x</li><li>y</li></ol><pre><code>if (a) {\n  b();\n}</code></pre><table><tr><th>K</th><th>V</th></tr><tr><td>p</td><td>8080</td></tr></table><blockquote>Quoted</blockquote><img src="a.png" alt="A chart"></main>`);
    expect(r.text).toBe("## Setup\n\nUse `bun i`.\n\n- a\n  - b\n- c\n\n1. x\n2. y\n\n```\nif (a) {\n  b();\n}\n```\n\nK | V\np | 8080\n\n> Quoted\n\n[image: A chart]");
  });

  test("links: words then [n], the same address once, an anchor, a script address and a mail address left out, relative addresses made whole, at most 40", () => {
    const r = text(`<main><a href="/a">One</a> <a href="/a">One again</a> <a href="#top">Top</a> <a href="javascript:x()">J</a> <a href="mailto:a@b.c">M</a> <a href="../up?x=1">Up</a> <a href="https://other.dev/p">Other</a></main>`);
    expect(r.text).toBe("One [1] One again [1] Top J M Up [2] Other [3]");
    expect(linkLines(r.links)).toBe("[1] https://docs.example.com/a\n[2] https://docs.example.com/up?x=1\n[3] https://other.dev/p");
    const many = text(`<main>${Array.from({ length: 60 }, (_, i) => `<a href="/p${i}">L${i}</a>`).join(" ")}</main>`);
    expect(many.links).toHaveLength(40);
  });

  test("entities, named and numeric", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &#169; &#x1F600; &nbsp;x &unknown; &#99999999;")).toBe('a & b <c> "d" © 😀  x &unknown; ');
  });

  test("broken markup does not stop it: unclosed tags, stray ends, a lone <, attributes without quotes, uppercase", () => {
    const r = text(`<MAIN><P CLASS=x>One<p>Two <b>bold <i>both</b> tail</i> 1 < 2 <div>Three</MAIN>`);
    expect(r.text).toBe("One\n\nTwo bold both tail 1 < 2\nThree");
  });

  test("a page of a megabyte is read in a moment and a deep page does not overflow", () => {
    const big = `<main>${"<p>word word word <a href='/x'>link</a></p>".repeat(30_000)}</main>`;
    const t0 = performance.now();
    const r = text(big);
    expect(performance.now() - t0).toBeLessThan(3_000);
    expect(r.text.length).toBeGreaterThan(300_000);
    expect(text(`<main>${"<div>".repeat(5_000)}deep${"</div>".repeat(5_000)}</main>`).text).toBe("deep");
  });
});

describe("what a heading carries is not text", () => {
  test("the sign that links a heading to itself is dropped, and a link with no address is only its words", () => {
    const r = htmlToText(`<main><h2>Global vs. local<a href="#global" class="anchor">#</a></h2><p><a name="x">plain words</a> and <a href="/y">real</a></p></main>`, "https://d.example.com/");
    expect(r.text).toBe("## Global vs. local\n\nplain words and real [1]");
  });
});
