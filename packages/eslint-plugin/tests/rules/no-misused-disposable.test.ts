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
    // is `Disposable`, ownership transfers to the stack.
    `
declare function makeResource(): Disposable;
declare const stack: DisposableStack;
function f() {
  const r = makeResource();
  stack.use(r);
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
    // Built-in `DisposableStack#use` transfers ownership — bare call statement
    // is treated as safe even though the method's return type is `Disposable`.
    `
declare function makeResource(): Disposable;
declare const stack: DisposableStack;
stack.use(makeResource());
    `,
    // Built-in `AsyncDisposableStack#use` — same but for async.
    `
declare function makeAsyncResource(): AsyncDisposable;
declare const stack: AsyncDisposableStack;
stack.use(makeAsyncResource());
    `,
    // Built-in `DisposableStack#adopt` — same passthrough shape.
    `
declare function makeResource(): unknown;
declare const stack: DisposableStack;
stack.adopt(makeResource(), () => {});
    `,
    // Method receiver must actually be a DisposableStack — a same-named method
    // on an unrelated type is NOT treated as safe. This confirms the built-in
    // check isn't matching by name alone. (Would normally flag; we bind via
    // `using` to keep the outer test case valid.)
    `
declare function makeResource(): Disposable;
class NotAStack {
  use(x: Disposable): Disposable {
    return x;
  }
}
declare const notStack: NotAStack;
{
  using r = notStack.use(makeResource());
}
    `,
    // Explicit manual dispose via `x[Symbol.dispose]()` — binding is released
    // in-place, no leak.
    `
declare function makeResource(): Disposable;
function f() {
  const r = makeResource();
  r[Symbol.dispose]();
}
    `,
    // Explicit manual async dispose via `await x[Symbol.asyncDispose]()`.
    `
declare function makeAsyncResource(): AsyncDisposable;
async function f() {
  const r = makeAsyncResource();
  await r[Symbol.asyncDispose]();
}
    `,
    // Multi-declarator with explicit dispose for each binding.
    `
declare function makeResource(): Disposable;
async function f() {
  const a = makeResource(),
    b = makeResource();
  a[Symbol.dispose]();
  b[Symbol.dispose]();
}
    `,
    // `for await...of x` auto-disposes `x`'s async iterator when the loop
    // body exits (ES2024 IteratorClose via `Symbol.asyncDispose`).
    `
declare function makeAsyncIterable(): AsyncIterable<number> & AsyncDisposable;
async function f() {
  const iter = makeAsyncIterable();
  for await (const v of iter) {
    console.log(v);
  }
}
    `,
    // `gen.return()` on an `AsyncGenerator` is the explicit close protocol —
    // `Symbol.asyncDispose` is defined to call `return(undefined)`.
    `
declare function makeAsyncGen(): AsyncGenerator<number>;
async function f() {
  const gen = makeAsyncGen();
  await gen.return(undefined);
}
    `,
    // Same for the sync `Generator`.
    `
declare function makeGen(): Generator<number>;
function f() {
  const gen = makeGen();
  gen.return(undefined);
}
    `,
    // Array whose element type has been stripped of `Symbol.dispose` (e.g.,
    // returned from a `stack.use(...)` augmentation that returns `Borrowed<T>`).
    // No element carries the dispose protocol, so the array doesn't trigger
    // the collection-of-disposables check.
    `
type Borrowed<T> = T extends null | undefined
  ? T
  : Omit<T, typeof Symbol.dispose | typeof Symbol.asyncDispose>;
declare function borrowResource(): Borrowed<Disposable>;
declare const items: number[];
{
  const handles = items.map(() => borrowResource());
  handles;
}
    `,
    // Array of disposables consumed via an `Iterable<Disposable>` parameter —
    // the destination contract is element-wise consumption, so ownership is
    // considered transferred (matches the user's `useAll(stack, items)` pattern).
    `
declare function makeResource(): Disposable;
declare function consumeAll<T extends Disposable>(items: Iterable<T>): void;
declare const items: number[];
function f() {
  const handles = items.map(() => makeResource());
  consumeAll(handles);
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
    // Explicit-dispose counterexample: a bare property read `r[Symbol.dispose]`
    // without invoking it is not disposal and must still be flagged.
    {
      code: `
declare function makeResource(): Disposable;
function f() {
  const r = makeResource();
  r[Symbol.dispose];
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
  r[Symbol.dispose];
}
      `,
            },
          ],
        },
      ],
    },
    // For-await-of counterexample: plain `for (... of ...)` does not
    // auto-dispose — only the `await` variant calls `Symbol.asyncDispose`.
    {
      code: `
declare function makeIterable(): Iterable<number> & Disposable;
function f() {
  const iter = makeIterable();
  for (const v of iter) {
    console.log(v);
  }
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
declare function makeIterable(): Iterable<number> & Disposable;
function f() {
  using iter = makeIterable();
  for (const v of iter) {
    console.log(v);
  }
}
      `,
            },
          ],
        },
      ],
    },
    // Array of disposables produced by `.map`, bound to a `const`, never
    // transferred or returned — every element leaks.
    {
      code: `
declare function makeResource(): Disposable;
declare const items: number[];
function f() {
  const handles = items.map(() => makeResource());
}
      `,
      errors: [
        {
          data: { kind: 'const', memberName: 'handles' },
          messageId: 'arrayDeclarationContainsDisposables',
        },
      ],
    },
    // Same shape but async.
    {
      code: `
declare function makeAsyncResource(): AsyncDisposable;
declare const items: number[];
async function f() {
  const handles = items.map(() => makeAsyncResource());
}
      `,
      errors: [
        {
          data: { kind: 'const', memberName: 'handles' },
          messageId: 'arrayDeclarationContainsAsyncDisposables',
        },
      ],
    },
    // Bare floating expression statement returning Disposable[].
    {
      code: `
declare function makeResource(): Disposable;
declare const items: number[];
function f() {
  items.map(() => makeResource());
}
      `,
      errors: [
        {
          messageId: 'floatingDisposableArrayVoid',
          suggestions: [
            {
              messageId: 'floatingFixVoid',
              output: `
declare function makeResource(): Disposable;
declare const items: number[];
function f() {
  void items.map(() => makeResource());
}
      `,
            },
          ],
        },
      ],
    },
    // Bare floating expression with ignoreVoid: false.
    {
      code: `
declare function makeAsyncResource(): AsyncDisposable;
declare const items: number[];
async function f() {
  items.map(() => makeAsyncResource());
}
      `,
      errors: [
        {
          messageId: 'floatingAsyncDisposableArray',
        },
      ],
      options: [{ ignoreVoid: false }],
    },
    // Tuple shape: `[Disposable, Disposable]` — element-aware detection still
    // fires even though the type is a tuple, not an array.
    {
      code: `
declare function makeResource(): Disposable;
function f() {
  const pair: [Disposable, Disposable] = [makeResource(), makeResource()];
}
      `,
      errors: [
        {
          data: { kind: 'const', memberName: 'pair' },
          messageId: 'arrayDeclarationContainsDisposables',
        },
      ],
    },
    // Array passed to a `Disposable[]`-typed function parameter — opaque
    // handoff, no per-element transfer guarantee. Still flagged.
    {
      code: `
declare function makeResource(): Disposable;
declare function takeArray(items: Disposable[]): void;
declare const items: number[];
function f() {
  const handles = items.map(() => makeResource());
  takeArray(handles);
}
      `,
      errors: [
        {
          data: { kind: 'const', memberName: 'handles' },
          messageId: 'arrayDeclarationContainsDisposables',
        },
      ],
    },
    // Array passed to a constructor parameter typed `Disposable[]` — same
    // opaque handoff. Mirrors the `new RebalanceTracker(inventories)` shape
    // observed in the perpbot-yellow smoke test.
    {
      code: `
declare function makeResource(): Disposable;
class Holder {
  constructor(items: Disposable[]) {}
}
declare const items: number[];
function f() {
  const handles = items.map(() => makeResource());
  return new Holder(handles);
}
      `,
      errors: [
        {
          data: { kind: 'const', memberName: 'handles' },
          messageId: 'arrayDeclarationContainsDisposables',
        },
      ],
    },
    // Function-return-shape: returning `Disposable[]` does NOT count as
    // ownership transfer to caller — caller can't `using`-bind an array.
    {
      code: `
declare function makeResource(): Disposable;
declare const items: number[];
function produce(): Disposable[] {
  const handles = items.map(() => makeResource());
  return handles;
}
      `,
      errors: [
        {
          data: { kind: 'const', memberName: 'handles' },
          messageId: 'arrayDeclarationContainsDisposables',
        },
      ],
    },
  ],
});

ruleTester.run(
  'no-misused-disposable (checkClassMembers: shape-and-dispose)',
  rule,
  {
    valid: [
      // Class implements [Symbol.dispose] and disposes its disposable field.
      {
        code: `
declare function makeResource(): Disposable;
class Owner {
  private res: Disposable = makeResource();
  [Symbol.dispose](): void {
    this.res[Symbol.dispose]();
  }
}
      `,
        options: [{ checkClassMembers: 'shape-and-dispose' }],
      },
      // Async-disposable class disposing an async-disposable field.
      {
        code: `
declare function makeAsyncResource(): AsyncDisposable;
class Owner {
  private res: AsyncDisposable = makeAsyncResource();
  async [Symbol.asyncDispose](): Promise<void> {
    await this.res[Symbol.asyncDispose]();
  }
}
      `,
        options: [{ checkClassMembers: 'shape-and-dispose' }],
      },
      // Field of type DisposableStack disposed via the named dispose() method.
      {
        code: `
class Owner {
  private stack = new DisposableStack();
  [Symbol.dispose](): void {
    this.stack.dispose();
  }
}
      `,
        options: [{ checkClassMembers: 'shape-and-dispose' }],
      },
      // Field of type AsyncDisposableStack disposed via the named disposeAsync() method.
      {
        code: `
class Owner {
  private stack = new AsyncDisposableStack();
  async [Symbol.asyncDispose](): Promise<void> {
    await this.stack.disposeAsync();
  }
}
      `,
        options: [{ checkClassMembers: 'shape-and-dispose' }],
      },
      // Constructor parameter property — caller-owned, exempt.
      {
        code: `
declare function makeResource(): Disposable;
class Owner {
  constructor(private res: Disposable) {}
}
      `,
        options: [{ checkClassMembers: 'shape-and-dispose' }],
      },
      // Static disposable field — exempt.
      {
        code: `
declare function makeResource(): Disposable;
class Owner {
  static shared: Disposable = makeResource();
}
      `,
        options: [{ checkClassMembers: 'shape-and-dispose' }],
      },
      // Field transferred to a stack inside dispose — counts as escape.
      {
        code: `
declare function makeAsyncResource(): AsyncDisposable;
class Owner {
  private res: AsyncDisposable = makeAsyncResource();
  private stack = new AsyncDisposableStack();
  async [Symbol.asyncDispose](): Promise<void> {
    this.stack.use(this.res);
    await this.stack[Symbol.asyncDispose]();
  }
}
      `,
        options: [{ checkClassMembers: 'shape-and-dispose' }],
      },
      // Sync-disposable field released inside [Symbol.asyncDispose] only.
      {
        code: `
declare function makeResource(): Disposable;
class Owner {
  private res: Disposable = makeResource();
  async [Symbol.asyncDispose](): Promise<void> {
    this.res[Symbol.dispose]();
  }
}
      `,
        options: [{ checkClassMembers: 'shape-and-dispose' }],
      },
      // Local alias to this.foo whose binding type is `Disposable` — counts as escape.
      {
        code: `
declare function makeResource(): Disposable;
class Owner {
  private res: Disposable = makeResource();
  [Symbol.dispose](): void {
    const r: Disposable = this.res;
    r[Symbol.dispose]();
  }
}
      `,
        options: [{ checkClassMembers: 'shape-and-dispose' }],
      },
      // Class with no disposable members — never reported.
      {
        code: `
class Plain {
  private name = 'x';
}
      `,
        options: [{ checkClassMembers: 'shape-and-dispose' }],
      },
      // `Borrowed<T>[]` field — element type has no `Symbol.dispose`, so it's
      // not detected as a disposable collection. Companion to the user-side
      // pattern where `stack.use(...)` strips the dispose symbols.
      {
        code: `
type Borrowed<T> = T extends null | undefined
  ? T
  : Omit<T, typeof Symbol.dispose | typeof Symbol.asyncDispose>;
class Owner {
  private items: Borrowed<Disposable>[] = [];
}
      `,
        options: [{ checkClassMembers: 'shape-and-dispose' }],
      },
      // Disposable[] field on a Disposable class — Check 2 skips arrays
      // (per-element disposal patterns are too varied to verify statically).
      {
        code: `
declare function makeResource(): Disposable;
class Owner {
  private items: Disposable[] = [makeResource()];
  [Symbol.dispose](): void {
    this.items.forEach(r => r[Symbol.dispose]());
  }
}
      `,
        options: [{ checkClassMembers: 'shape-and-dispose' }],
      },
      // Default behavior (option off) — still no report.
      `
declare function makeResource(): Disposable;
class Owner {
  private res: Disposable = makeResource();
}
    `,
    ],

    invalid: [
      // Plain class holding a Disposable field — must be Disposable.
      {
        code: `
declare function makeResource(): Disposable;
class Owner {
  private res: Disposable = makeResource();
}
      `,
        errors: [{ messageId: 'classWithDisposableMemberNotDisposable' }],
        options: [{ checkClassMembers: 'shape' }],
      },
      // Disposable class with two fields — only one disposed.
      {
        code: `
declare function makeResource(): Disposable;
class Owner {
  private a: Disposable = makeResource();
  private b: Disposable = makeResource();
  [Symbol.dispose](): void {
    this.a[Symbol.dispose]();
  }
}
      `,
        errors: [
          {
            data: { kind: '', memberName: 'b', disposeKey: 'dispose' },
            messageId: 'classMemberNotDisposed',
          },
        ],
        options: [{ checkClassMembers: 'shape-and-dispose' }],
      },
      // Sync-only disposable class with an async-disposable field.
      {
        code: `
declare function makeAsyncResource(): AsyncDisposable;
class Owner {
  private res: AsyncDisposable = makeAsyncResource();
  [Symbol.dispose](): void {}
}
      `,
        errors: [{ messageId: 'asyncMemberInSyncDisposableClass' }],
        options: [{ checkClassMembers: 'shape-and-dispose' }],
      },
      // Field referenced only by a non-disposable destination.
      {
        code: `
declare function makeResource(): Disposable;
declare function log(_: unknown): void;
class Owner {
  private res: Disposable = makeResource();
  [Symbol.dispose](): void {
    log(this.res);
  }
}
      `,
        errors: [{ messageId: 'classMemberNotDisposed' }],
        options: [{ checkClassMembers: 'shape-and-dispose' }],
      },
      // Field referenced only by reassignment in dispose.
      {
        code: `
declare function makeResource(): Disposable;
class Owner {
  private res: Disposable = makeResource();
  [Symbol.dispose](): void {
    this.res = undefined!;
  }
}
      `,
        errors: [{ messageId: 'classMemberNotDisposed' }],
        options: [{ checkClassMembers: 'shape-and-dispose' }],
      },
      // Class with [Symbol.asyncDispose] only and a Disposable field never referenced.
      {
        code: `
declare function makeResource(): Disposable;
class Owner {
  private res: Disposable = makeResource();
  async [Symbol.asyncDispose](): Promise<void> {}
}
      `,
        errors: [{ messageId: 'classMemberNotDisposed' }],
        options: [{ checkClassMembers: 'shape-and-dispose' }],
      },
      // Anonymous class expression with a leaking field.
      {
        code: `
declare function makeResource(): Disposable;
const C = class {
  private res: Disposable = makeResource();
};
      `,
        errors: [
          {
            data: {
              className: '<anonymous class>',
              disposeKey: 'dispose',
              kind: '',
              memberName: 'res',
            },
            messageId: 'classWithDisposableMemberNotDisposable',
          },
        ],
        options: [{ checkClassMembers: 'shape' }],
      },
      // Private-identifier field in a non-disposable class.
      {
        code: `
declare function makeResource(): Disposable;
class Owner {
  #res: Disposable = makeResource();
}
      `,
        errors: [
          {
            data: {
              className: 'Owner',
              disposeKey: 'dispose',
              kind: '',
              memberName: '#res',
            },
            messageId: 'classWithDisposableMemberNotDisposable',
          },
        ],
        options: [{ checkClassMembers: 'shape' }],
      },
      // Array-of-disposables field in a non-disposable class.
      {
        code: `
declare function makeResource(): Disposable;
class Owner {
  private items: Disposable[] = [makeResource()];
}
      `,
        errors: [
          {
            data: {
              className: 'Owner',
              disposeKey: 'dispose',
              kind: '',
              memberName: 'items',
            },
            messageId: 'classWithDisposableArrayMemberNotDisposable',
          },
        ],
        options: [{ checkClassMembers: 'shape' }],
      },
    ],
  },
);
