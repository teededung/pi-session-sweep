import { matchesKey, type Component } from "@earendil-works/pi-tui";

import {
  computeCursorScroll,
  formatBold,
  formatTheme,
  frameDivider,
  frameLine,
  frameTop,
  moveCursorWithinBounds,
  resolveMaxRenderRows as resolveMaxRenderRowsBase,
  resolveNavigationKey,
  type KeybindingsLike,
  type ThemeLike,
} from "./frame-helpers.ts";

export abstract class ListPicker implements Component {
  readonly capturesViewportInput = true;
  protected cursorIndex = 0;
  protected scrollOffset = 0;
  protected lastViewportSize = 1;
  protected readonly theme: ThemeLike;
  protected readonly maxRenderRows: number;
  protected readonly requestRender: () => void;
  protected readonly keybindings?: KeybindingsLike;

  protected constructor(
    theme: ThemeLike,
    maxRenderRows: number,
    requestRender: () => void,
    keybindings?: KeybindingsLike,
  ) {
    this.theme = theme;
    this.maxRenderRows = maxRenderRows;
    this.requestRender = requestRender;
    this.keybindings = keybindings;
  }

  protected abstract get itemCount(): number;

  protected abstract get minRenderHeight(): number;

  protected abstract onCancel(): void;

  protected abstract handlePickerAction(data: string): void;

  abstract render(width: number): string[];

  invalidate(): void {}

  protected onCursorMoved(): void {}

  handleInput(data: string): void {
    if (
      this.keybindings?.matches(data, "tui.select.cancel") ||
      matchesKey(data, "escape") ||
      matchesKey(data, "ctrl+c") ||
      matchesKey(data, "q")
    ) {
      this.onCancel();
      return;
    }

    if (this.handleNavigation(data)) {
      return;
    }

    this.handlePickerAction(data);
  }

  protected handleNavigation(data: string): boolean {
    const navigation = resolveNavigationKey(data, this.lastViewportSize, this.keybindings);
    if (!navigation.handled) {
      return false;
    }

    if (navigation.action === "move") {
      this.moveCursor(navigation.delta);
    } else {
      this.cursorIndex = navigation.action === "home" ? 0 : Math.max(0, this.itemCount - 1);
      this.onCursorMoved();
      this.ensureCursorVisible(this.lastViewportSize);
      this.requestRender();
    }
    return true;
  }

  protected prepareViewport(viewportSize: number): { start: number; end: number } {
    this.lastViewportSize = viewportSize;
    this.ensureCursorVisible(viewportSize);
    const start = this.scrollOffset;
    const end = Math.min(this.itemCount, start + viewportSize);
    return { start, end };
  }

  protected moveCursor(delta: number): void {
    const result = moveCursorWithinBounds(
      this.cursorIndex,
      this.scrollOffset,
      this.itemCount,
      delta,
      this.lastViewportSize,
    );
    this.cursorIndex = result.cursorIndex;
    this.scrollOffset = result.scrollOffset;
    if (result.moved) {
      this.onCursorMoved();
      this.ensureCursorVisible(this.lastViewportSize);
      this.requestRender();
    }
  }

  protected resolveMaxRenderRows(): number {
    return resolveMaxRenderRowsBase(this.maxRenderRows, this.minRenderHeight);
  }

  protected ensureCursorVisible(viewportSize: number): void {
    const next = computeCursorScroll(
      this.cursorIndex,
      this.scrollOffset,
      this.itemCount,
      viewportSize,
    );
    this.cursorIndex = next.cursorIndex;
    this.scrollOffset = next.scrollOffset;
  }

  protected pushPickerHeader(
    lines: string[],
    frameInnerWidth: number,
    title: string,
    statsContent: string,
  ): void {
    lines.push(frameTop(frameInnerWidth));
    lines.push(
      formatTheme(this.theme, "accent", formatBold(this.theme, frameLine(` ${title}`, frameInnerWidth))),
    );
    lines.push(formatTheme(this.theme, "dim", frameLine(statsContent, frameInnerWidth)));
    lines.push(frameDivider(frameInnerWidth));
  }

  protected formatPickerRow(frameInnerWidth: number, content: string, isCursor: boolean): string {
    const framed = frameLine(content, frameInnerWidth);
    return isCursor
      ? formatTheme(this.theme, "accent", formatBold(this.theme, framed))
      : framed;
  }
}
