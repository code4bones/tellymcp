/** Self-contained: serialized by Playwright and the extension build into the page. */
export function readDomBatch(input: {
  selector?: string;
  include_html?: boolean;
  include_text?: boolean;
  limit?: number;
  max_chars?: number;
}) {
  type DomElement = {
    outerHTML: string;
    textContent: string | null;
    attributes: ArrayLike<{ name: string; value: string }>;
  };
  const page = globalThis as unknown as {
    document: {
      querySelectorAll(selector: string): ArrayLike<DomElement>;
      title: string;
    };
    location: { href: string };
    getComputedStyle(element: DomElement): {
      display: string;
      visibility: string;
      opacity: string;
    };
  };
  const limit = Math.min(50, Math.max(1, Math.trunc(input.limit || 50)));
  let remaining = Math.min(
    65536,
    Math.max(256, Math.trunc(input.max_chars || 32768)),
  );
  let truncated = false;
  const take = (text: string, maximum = 16384): string => {
    const count = Math.min(remaining, maximum);
    const value = text.slice(0, count);
    if (value.length < text.length) truncated = true;
    remaining -= value.length;
    return value;
  };
  const nodes = page.document.querySelectorAll(
    input.selector?.trim() || "body",
  );
  const elements: Array<{
    index: number;
    text_content?: string;
    outer_html?: string;
    attributes: Record<string, string>;
    visible: boolean;
  }> = [];
  for (let index = 0; index < Math.min(nodes.length, limit); index++) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const element = nodes[index]!;
    const computed = page.getComputedStyle(element);
    const attributes: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    const marker = (name: string) =>
      name === "data-ai-picker" || name === "data-ai-picker-item";
    const ordered = Array.from(element.attributes).sort(
      (a, b) => Number(marker(b.name)) - Number(marker(a.name)),
    );
    for (const attribute of ordered.slice(0, 16)) {
      const name = take(attribute.name, 64);
      if (name) attributes[name] = take(attribute.value, 512);
    }
    if (element.attributes.length > 16) truncated = true;
    const text =
      input.include_text !== false
        ? take((element.textContent || "").trim())
        : undefined;
    const html =
      input.include_html !== false ? take(element.outerHTML) : undefined;
    elements.push({
      index,
      ...(text !== undefined ? { text_content: text } : {}),
      ...(html !== undefined ? { outer_html: html } : {}),
      attributes,
      visible:
        computed.display !== "none" &&
        computed.visibility !== "hidden" &&
        computed.opacity !== "0",
    });
  }
  return {
    found: nodes.length > 0,
    total: nodes.length,
    truncated: truncated || nodes.length > elements.length,
    elements,
    url: page.location.href.slice(0, 2048),
    title: page.document.title.slice(0, 512),
  };
}
