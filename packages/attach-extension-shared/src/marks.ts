export const MARK_ATTRIBUTE = "data-ai-picker";
export const MARK_ITEM_ATTRIBUTE = "data-ai-picker-item";
export const MAX_MARKS = 50;

type Mark = {
  element: Element;
  id: number;
  previousGroup: string | null;
  previousItem: string | null;
};

/** Keep node references, never copy selected DOM contents into the request. */
export class MarkingSession {
  public readonly id = crypto.randomUUID();
  private readonly selected = new Map<Element, Mark>();
  private sequence = 0;
  public get items(): Mark[] {
    return [...this.selected.values()];
  }
  public get selector(): string {
    return `[${MARK_ATTRIBUTE}="${this.id}"]`;
  }
  public get valid(): boolean {
    return (
      this.selected.size > 0 &&
      this.items.every(
        (mark) =>
          mark.element.isConnected &&
          mark.element.getAttribute(MARK_ATTRIBUTE) === this.id &&
          mark.element.getAttribute(MARK_ITEM_ATTRIBUTE) === String(mark.id),
      )
    );
  }
  public containing(element: Element): Element | undefined {
    return this.items.find((mark) => mark.element.contains(element))?.element;
  }
  public toggle(element: Element): void {
    const containing = this.containing(element);
    if (containing) {
      this.remove(containing);
      return;
    }
    if (element.getRootNode() !== document)
      throw new Error(
        "Marking supports top-frame DOM elements; Shadow DOM is not supported.",
      );
    const descendants = this.items.filter((mark) =>
      element.contains(mark.element),
    );
    if (this.selected.size - descendants.length >= MAX_MARKS)
      throw new Error("Up to 50 marked elements are supported.");
    for (const mark of descendants) this.remove(mark.element);
    const mark = {
      element,
      id: ++this.sequence,
      previousGroup: element.getAttribute(MARK_ATTRIBUTE),
      previousItem: element.getAttribute(MARK_ITEM_ATTRIBUTE),
    };
    this.selected.set(element, mark);
    element.setAttribute(MARK_ATTRIBUTE, this.id);
    element.setAttribute(MARK_ITEM_ATTRIBUTE, String(mark.id));
  }
  public remove(element: Element): void {
    const mark = this.selected.get(element);
    if (!mark) return;
    const restore = (name: string, previous: string | null) => {
      if (previous === null) element.removeAttribute(name);
      else element.setAttribute(name, previous);
    };
    if (element.getAttribute(MARK_ATTRIBUTE) === this.id) {
      restore(MARK_ATTRIBUTE, mark.previousGroup);
      if (element.getAttribute(MARK_ITEM_ATTRIBUTE) === String(mark.id))
        restore(MARK_ITEM_ATTRIBUTE, mark.previousItem);
    }
    this.selected.delete(element);
  }
  public clear(): void {
    for (const mark of this.items) this.remove(mark.element);
  }
}
