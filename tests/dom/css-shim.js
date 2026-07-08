// Deno cannot import CSS modules. The spreadsheet source imports `./sheet.css`
// purely so esbuild bundles the styles; under `deno test` that side effect is
// irrelevant, so the import map redirects the CSS here (see deno.json).
export {};
