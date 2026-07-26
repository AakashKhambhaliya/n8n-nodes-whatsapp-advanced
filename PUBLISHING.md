# Publishing

## 1. Check the metadata

`homepage`, `repository`, `bugs` and `author` point at
`github.com/AakashKhambhaliya/n8n-nodes-whatsapp-advanced`, and `README.md`'s clone instructions use
the same URL. If the repository ever moves, all four have to move with it — npm renders dead links
without complaining.

```bash
grep -rn "github.com" package.json README.md
```

No email is published in `author`; npm already shows the publishing account.

## 2. Check the name is free

```bash
npm view n8n-nodes-whatsapp-advanced
```

A 404 means the name is available. If it is taken, rename — the package name **must** start with
`n8n-nodes-` for n8n to recognise it as a community node, and the `n8n-community-node-package`
keyword must stay in place or it will not appear in n8n's community node search.

## 3. Verify

```bash
npm ci
npm run lint      # eslint-plugin-n8n-nodes-base, must be clean
npm test          # builds, then runs all four suites
npm pack --dry-run
```

Expect **27 files, ~29 kB packed**. The tarball should contain `dist/`, `LICENSE`, `README.md`,
`package.json` and `index.js` — nothing else. If `dist/` is empty, delete `.tsbuildinfo` and
rebuild; a stale incremental cache makes `tsc` skip emit silently.

A stray `dist/package.json` means `package.json` has been added back to `tsconfig.json`'s `include`.
It belongs out of the TypeScript program; ESLint reads it through the `parserOptions: { project: null }`
override in `.eslintrc.js` instead.

## 4. Test it inside a real n8n before publishing

```bash
npm run build
npm link

mkdir -p ~/.n8n/custom && cd ~/.n8n/custom
npm init -y                                  # first time only
npm link n8n-nodes-whatsapp-advanced
n8n start
```

Work through **Phase 10** in `BUILD-PLAN.md` against a real WhatsApp Business Account. The items
that cannot be caught by unit tests:

- the resource mapper actually re-renders when the template changes
- a named-parameter template delivers (the case the official node cannot do)
- auto-routing picks the right endpoint per template category
- a status webhook echoes back the same `trackingRef` the send returned

## 5. Publish

```bash
npm login
npm publish --access public
```

`prepublishOnly` runs build, lint and tests first and will abort the publish if any fail.

Tag the release:

```bash
git tag v1.0.0 && git push --tags
```

## 6. Afterwards

Installable via **Settings → Community nodes → Install** → `n8n-nodes-whatsapp-advanced`.

Community nodes run on **self-hosted n8n only** unless they pass n8n's verification review. If you
want it available on n8n Cloud, submit it for verification — the requirements are stricter than the
lint rules (no external dependencies beyond `n8n-workflow`, which this package already satisfies).

## Version bumps

Follow semver against the **node's UI and output contract**, not the internal code:

- **patch** — error-code mapping corrections, guidance text, bug fixes
- **minor** — new template types covered, new operations, new options
- **major** — renamed field IDs (breaks stored resource-mapper schemas in existing workflows),
  changed output shape, removed options

Renaming anything in the field-ID grammar (`b::text::…`, `btn::0::url::…`) is a **breaking change**:
n8n stores those IDs inside saved workflows, and existing nodes would lose their values.
