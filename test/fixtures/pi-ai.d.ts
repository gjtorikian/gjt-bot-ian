// pi resolves this import to its own bundled copy when it loads the fixture, so
// the package is not installed here. Declare only what the fixture calls.
declare module '@earendil-works/pi-ai' {
  export function createAssistantMessageEventStream(): {
    push(event: object): void;
    end(): void;
  };
}
