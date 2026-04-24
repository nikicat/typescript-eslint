import rule from '../../src/rules/no-misused-disposable';
import { createRuleTesterWithTypes } from '../RuleTester';

const ruleTester = createRuleTesterWithTypes();

ruleTester.run('no-misused-disposable', rule, {
  valid: [
    // `using` binds disposal properly.
    `
declare function makeResource(): Disposable;
{
  using r = makeResource();
}
    `,
    // `await using` binds async disposal.
    `
declare function makeAsyncResource(): AsyncDisposable;
async function f() {
  await using r = makeAsyncResource();
}
    `,
    // Union where one constituent is disposable, handled via `using`.
    `
declare function makeMaybe(): Disposable | null;
{
  using r = makeMaybe();
}
    `,
    // Returning is an escape — caller owns disposal.
    `
declare function makeResource(): Disposable;
function produce(): Disposable {
  return makeResource();
}
    `,
    // Aliasing: assigning an already-owned disposable to a new const does not
    // transfer ownership but is a common pattern and is intentionally skipped.
    `
declare function makeResource(): Disposable;
{
  using original = makeResource();
  const alias = original;
  alias;
}
    `,
    // `void` opt-out with default `ignoreVoid: true`.
    `
declare function makeResource(): Disposable;
void makeResource();
    `,
    // `void` opt-out on async disposable.
    `
declare function makeAsyncResource(): AsyncDisposable;
void makeAsyncResource();
    `,
    // Non-disposable call is never flagged.
    `
declare function makeNumber(): number;
makeNumber();
const n = makeNumber();
    `,
    // Non-call expression statement with non-disposable value.
    `
declare const x: number;
x;
    `,
    // Assignment expression — not a new disposable value.
    `
declare const holder: { current: Disposable | null };
declare function makeResource(): Disposable;
holder.current = makeResource();
    `,
    // `setTimeout` happens to be tagged `Disposable` in recent Node types;
    // `allowForKnownSafeCalls` lets the user silence such calls.
    {
      code: `
declare function safeDispose(): Disposable;
safeDispose();
      `,
      options: [
        {
          allowForKnownSafeCalls: [
            {
              from: 'file',
              name: 'safeDispose',
            },
          ],
        },
      ],
    },
    // `allowForKnownSafeDisposables` silences values of a specific type.
    {
      code: `
type SafeDisposable = Disposable & { __safe?: true };
declare function makeSafe(): SafeDisposable;
makeSafe();
const x = makeSafe();
      `,
      options: [
        {
          allowForKnownSafeDisposables: [
            {
              from: 'file',
              name: 'SafeDisposable',
            },
          ],
        },
      ],
    },
    // Class instantiation bound via `using`.
    `
class MyResource {
  [Symbol.dispose](): void {}
}
{
  using r = new MyResource();
}
    `,
    // Logical expression where both branches are handled (returned).
    `
declare function makeA(): Disposable;
declare function makeB(): Disposable;
function pick(flag: boolean): Disposable {
  return flag ? makeA() : makeB();
}
    `,
    // `for (const ...)` is not handled by this rule in the MVP — parent
    // is not a block/program — so loop-bound disposables are not flagged.
    `
declare const arr: Disposable[];
for (const r of arr) {
  r;
}
    `,
    // Export declarations are not handled — escape via export.
    `
declare function makeResource(): Disposable;
export const exported = makeResource();
    `,
    // Escape analysis: binding returned from a function whose return type
    // preserves the `Disposable` shape.
    `
declare function makeResource(): Disposable;
function produce(): Disposable {
  const r = makeResource();
  return r;
}
    `,
    // Escape analysis: async variant — return type preserves `AsyncDisposable`.
    `
declare function makeAsyncResource(): AsyncDisposable;
async function produce(): Promise<AsyncDisposable> {
  const r = makeAsyncResource();
  return r;
}
    `,
    // Escape analysis: return type is a union containing `Disposable`.
    `
declare function makeResource(): Disposable;
function maybe(flag: boolean): Disposable | null {
  const r = makeResource();
  return flag ? r : null;
}
    `,
    // Escape analysis: passed as an argument to a function whose parameter
    // accepts `Disposable`.
    `
declare function makeResource(): Disposable;
declare function register(value: Disposable): void;
function f() {
  const r = makeResource();
  register(r);
}
    `,
    // Escape analysis: passed to `DisposableStack#use` — whose parameter type
    // is `Disposable`, ownership transfers to the stack. The `void` prefix is
    // only needed to silence the separate `ExpressionStatement` report on the
    // passthrough return value.
    `
declare function makeResource(): Disposable;
declare const stack: DisposableStack;
function f() {
  const r = makeResource();
  void stack.use(r);
}
    `,
    // Escape analysis: assigned to an object property whose type carries
    // `AsyncDisposable`.
    `
declare function makeAsyncResource(): AsyncDisposable;
declare const holder: { current: AsyncDisposable | null };
async function f() {
  const r = makeAsyncResource();
  holder.current = r;
}
    `,
    // Escape analysis: used as an object literal property value where the
    // contextual type expects a `Disposable` there.
    `
declare function makeResource(): Disposable;
declare function register(options: { resource: Disposable }): void;
function f() {
  const r = makeResource();
  register({ resource: r });
}
    `,
    // Escape analysis: placed in an array whose contextual element type is
    // `AsyncDisposable[]`.
    `
declare function makeAsyncResource(): AsyncDisposable;
declare function registerAll(resources: AsyncDisposable[]): void;
async function f() {
  const r = makeAsyncResource();
  registerAll([r]);
}
    `,
    // Escape analysis: arrow implicit return whose return type preserves the
    // disposable.
    `
declare function makeResource(): Disposable;
const produce: () => Disposable = () => {
  const r = makeResource();
  return r;
};
    `,
    // Escape analysis: alias chain where the aliasing declarator's bound type
    // preserves the disposable.
    `
declare function makeResource(): Disposable;
function produce(): Disposable {
  const r = makeResource();
  const alias: Disposable = r;
  return alias;
}
    `,
  ],

  invalid: [
    // Bare producer call: sync Disposable.
    {
      code: `
declare function makeResource(): Disposable;
makeResource();
      `,
      errors: [
        {
          line: 3,
          messageId: 'floatingDisposableVoid',
          suggestions: [
            {
              messageId: 'floatingFixVoid',
              output: `
declare function makeResource(): Disposable;
void makeResource();
      `,
            },
          ],
        },
      ],
    },
    // Bare producer call: async AsyncDisposable uses the async message id.
    {
      code: `
declare function makeAsyncResource(): AsyncDisposable;
makeAsyncResource();
      `,
      errors: [
        {
          line: 3,
          messageId: 'floatingAsyncDisposableVoid',
          suggestions: [
            {
              messageId: 'floatingFixVoid',
              output: `
declare function makeAsyncResource(): AsyncDisposable;
void makeAsyncResource();
      `,
            },
          ],
        },
      ],
    },
    // With `ignoreVoid: false` the non-void message id is used and no
    // `void` suggestion is offered.
    {
      code: `
declare function makeResource(): Disposable;
makeResource();
      `,
      errors: [
        {
          line: 3,
          messageId: 'floatingDisposable',
        },
      ],
      options: [{ ignoreVoid: false }],
    },
    // `const` declaration gets a suggestion to use `using`.
    {
      code: `
declare function makeResource(): Disposable;
function f() {
  const r = makeResource();
}
      `,
      errors: [
        {
          data: { kind: 'const' },
          line: 4,
          messageId: 'useDeclarationShouldBeUsing',
          suggestions: [
            {
              messageId: 'floatingFixUsing',
              output: `
declare function makeResource(): Disposable;
function f() {
  using r = makeResource();
}
      `,
            },
          ],
        },
      ],
    },
    // `let` declaration for async disposable suggests `await using`.
    {
      code: `
declare function makeAsyncResource(): AsyncDisposable;
async function f() {
  let r = makeAsyncResource();
}
      `,
      errors: [
        {
          data: { kind: 'let' },
          line: 4,
          messageId: 'useDeclarationShouldBeAwaitUsing',
          suggestions: [
            {
              messageId: 'floatingFixAwaitUsing',
              output: `
declare function makeAsyncResource(): AsyncDisposable;
async function f() {
  await using r = makeAsyncResource();
}
      `,
            },
          ],
        },
      ],
    },
    // `var` declaration also flagged.
    {
      code: `
declare function makeResource(): Disposable;
function f() {
  var r = makeResource();
}
      `,
      errors: [
        {
          data: { kind: 'var' },
          line: 4,
          messageId: 'useDeclarationShouldBeUsing',
          suggestions: [
            {
              messageId: 'floatingFixUsing',
              output: `
declare function makeResource(): Disposable;
function f() {
  using r = makeResource();
}
      `,
            },
          ],
        },
      ],
    },
    // Multi-declarator: report each but do not offer a suggestion (cannot
    // safely rewrite the single `kind` keyword).
    {
      code: `
declare function makeA(): Disposable;
declare function makeB(): Disposable;
function f() {
  const a = makeA(),
    b = makeB();
}
      `,
      errors: [
        {
          data: { kind: 'const' },
          line: 5,
          messageId: 'useDeclarationShouldBeUsing',
        },
        {
          data: { kind: 'const' },
          line: 6,
          messageId: 'useDeclarationShouldBeUsing',
        },
      ],
    },
    // Union type with a Disposable member is still reported.
    {
      code: `
declare function makeMaybe(): Disposable | null;
makeMaybe();
      `,
      errors: [
        {
          line: 3,
          messageId: 'floatingDisposableVoid',
          suggestions: [
            {
              messageId: 'floatingFixVoid',
              output: `
declare function makeMaybe(): Disposable | null;
void makeMaybe();
      `,
            },
          ],
        },
      ],
    },
    // Intersection type `T & AsyncDisposable` is reported as async.
    {
      code: `
declare function makeIntersected(): { foo: string } & AsyncDisposable;
makeIntersected();
      `,
      errors: [
        {
          line: 3,
          messageId: 'floatingAsyncDisposableVoid',
          suggestions: [
            {
              messageId: 'floatingFixVoid',
              output: `
declare function makeIntersected(): { foo: string } & AsyncDisposable;
void makeIntersected();
      `,
            },
          ],
        },
      ],
    },
    // Conditional expression: report if any branch is disposable.
    {
      code: `
declare function makeResource(): Disposable;
declare const flag: boolean;
flag ? makeResource() : undefined;
      `,
      errors: [
        {
          line: 4,
          messageId: 'floatingDisposableVoid',
          suggestions: [
            {
              messageId: 'floatingFixVoid',
              output: `
declare function makeResource(): Disposable;
declare const flag: boolean;
void (flag ? makeResource() : undefined);
      `,
            },
          ],
        },
      ],
    },
    // Sequence expression: report if any expression is disposable.
    {
      code: `
declare function makeResource(): Disposable;
(0, makeResource());
      `,
      errors: [
        {
          line: 3,
          messageId: 'floatingDisposableVoid',
          suggestions: [
            {
              messageId: 'floatingFixVoid',
              output: `
declare function makeResource(): Disposable;
void (0, makeResource());
      `,
            },
          ],
        },
      ],
    },
    // Logical expression: report if any side is disposable.
    {
      code: `
declare function makeResource(): Disposable;
declare const flag: boolean;
flag && makeResource();
      `,
      errors: [
        {
          line: 4,
          messageId: 'floatingDisposableVoid',
          suggestions: [
            {
              messageId: 'floatingFixVoid',
              output: `
declare function makeResource(): Disposable;
declare const flag: boolean;
void (flag && makeResource());
      `,
            },
          ],
        },
      ],
    },
    // Object literal with `Symbol.dispose` is a disposable.
    {
      code: `
({ [Symbol.dispose]() {} });
      `,
      errors: [
        {
          line: 2,
          messageId: 'floatingDisposableVoid',
          suggestions: [
            {
              messageId: 'floatingFixVoid',
              output: `
void ({ [Symbol.dispose]() {} });
      `,
            },
          ],
        },
      ],
    },
    // `new` expression for a class with `Symbol.dispose`.
    {
      code: `
class Res {
  [Symbol.dispose](): void {}
}
function f() {
  const r = new Res();
}
      `,
      errors: [
        {
          data: { kind: 'const' },
          line: 6,
          messageId: 'useDeclarationShouldBeUsing',
          suggestions: [
            {
              messageId: 'floatingFixUsing',
              output: `
class Res {
  [Symbol.dispose](): void {}
}
function f() {
  using r = new Res();
}
      `,
            },
          ],
        },
      ],
    },
    // With `ignoreVoid: false`, `void makeResource()` is still reported.
    {
      code: `
declare function makeResource(): Disposable;
void makeResource();
      `,
      errors: [
        {
          line: 3,
          messageId: 'floatingDisposable',
        },
      ],
      options: [{ ignoreVoid: false }],
    },
    // Known MVP limitation: `DisposableStack#use` returns the value it
    // receives, so a bare `stack.use(makeResource())` statement has a
    // `Disposable` return type and is flagged. Users can silence this with
    // the `allowForKnownSafeCalls` option.
    {
      code: `
declare function makeResource(): Disposable;
declare const stack: DisposableStack;
stack.use(makeResource());
      `,
      errors: [
        {
          line: 4,
          messageId: 'floatingDisposableVoid',
          suggestions: [
            {
              messageId: 'floatingFixVoid',
              output: `
declare function makeResource(): Disposable;
declare const stack: DisposableStack;
void stack.use(makeResource());
      `,
            },
          ],
        },
      ],
    },
    // Escape-analysis counterexample: passing the binding to `console.log`
    // does not transfer ownership (parameter type is `unknown`), so it remains
    // a leak and the declaration is still flagged.
    {
      code: `
declare function makeResource(): Disposable;
function f() {
  const r = makeResource();
  console.log(r);
}
      `,
      errors: [
        {
          data: { kind: 'const' },
          line: 4,
          messageId: 'useDeclarationShouldBeUsing',
          suggestions: [
            {
              messageId: 'floatingFixUsing',
              output: `
declare function makeResource(): Disposable;
function f() {
  using r = makeResource();
  console.log(r);
}
      `,
            },
          ],
        },
      ],
    },
    // Escape-analysis counterexample: returning a `non-Disposable` property of
    // the binding does not transfer ownership of the binding itself.
    {
      code: `
declare function makeResource(): Disposable & { name: string };
function produce(): string {
  const r = makeResource();
  return r.name;
}
      `,
      errors: [
        {
          data: { kind: 'const' },
          line: 4,
          messageId: 'useDeclarationShouldBeUsing',
          suggestions: [
            {
              messageId: 'floatingFixUsing',
              output: `
declare function makeResource(): Disposable & { name: string };
function produce(): string {
  using r = makeResource();
  return r.name;
}
      `,
            },
          ],
        },
      ],
    },
    // Escape-analysis counterexample: returning from a `void`-returning
    // function means no ownership transfer (no destination type).
    {
      code: `
declare function makeResource(): Disposable;
function f(): void {
  const r = makeResource();
  return;
  r;
}
      `,
      errors: [
        {
          data: { kind: 'const' },
          line: 4,
          messageId: 'useDeclarationShouldBeUsing',
          suggestions: [
            {
              messageId: 'floatingFixUsing',
              output: `
declare function makeResource(): Disposable;
function f(): void {
  using r = makeResource();
  return;
  r;
}
      `,
            },
          ],
        },
      ],
    },
  ],
});
