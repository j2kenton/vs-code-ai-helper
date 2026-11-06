/**
 * review1 Step 54: lets the code that posts a card ask the auto-continue sweep for a pass right now (a card the owner
 * already said "keep going" for should not wait for the next timer tick). The sweep registers its pass when it starts;
 * with no sweep running (a viewer window, a test) the request does nothing.
 */
let handlerV1: (() => void) | undefined;

export function setAutoContinueSweepNowHandlerV1(handler: (() => void) | undefined): void {
  handlerV1 = handler;
}

export function requestAutoContinueSweepNowV1(): void {
  handlerV1?.();
}
