// The packaged CLI does not expose Ink's optional React DevTools integration.
// This keeps the production ESM bundle self-contained without adding a runtime-only
// debugging dependency that Ink loads exclusively when DEV=true.
const devtools = {
  initialize(): void {},
  connectToDevTools(): void {},
};

export default devtools;
