import type { TSESLint, TSESTree } from '@typescript-eslint/utils';
import type * as ts from 'typescript';

import { AST_NODE_TYPES } from '@typescript-eslint/utils';
import * as tsutils from 'ts-api-utils';

import type { TypeOrValueSpecifier } from '../util';

import {
  createRule,
  getOperatorPrecedenceForNode,
  getParserServices,
  isBuiltinSymbolLike,
  isParenthesized,
  nullThrows,
  NullThrowsReasons,
  OperatorPrecedence,
  readonlynessOptionsDefaults,
  readonlynessOptionsSchema,
  skipChainExpression,
  typeMatchesSomeSpecifier,
  valueMatchesSomeSpecifier,
} from '../util';
import { getParentFunctionNode } from '../util/getParentFunctionNode';

export type Options = [
  {
    allowForKnownSafeCalls?: TypeOrValueSpecifier[];
    allowForKnownSafeDisposables?: TypeOrValueSpecifier[];
    checkClassMembers?: 'off' | 'shape' | 'shape-and-dispose';
    ignoreVoid?: boolean;
  },
];

export type MessageId =
  | 'asyncMemberInSyncDisposableClass'
  | 'classMemberNotDisposed'
  | 'classWithDisposableMemberNotDisposable'
  | 'floatingAsyncDisposable'
  | 'floatingAsyncDisposableVoid'
  | 'floatingDisposable'
  | 'floatingDisposableVoid'
  | 'floatingFixAwaitUsing'
  | 'floatingFixUsing'
  | 'floatingFixVoid'
  | 'useDeclarationShouldBeAwaitUsing'
  | 'useDeclarationShouldBeUsing';

type DisposableKind = 'async' | 'sync' | null;

function getDisposableKind(
  type: ts.Type,
  checker: ts.TypeChecker,
): DisposableKind {
  let kind: DisposableKind = null;
  for (const part of tsutils.unionConstituents(checker.getApparentType(type))) {
    if (
      tsutils.getWellKnownSymbolPropertyOfType(part, 'asyncDispose', checker) !=
      null
    ) {
      return 'async';
    }
    if (
      tsutils.getWellKnownSymbolPropertyOfType(part, 'dispose', checker) != null
    ) {
      kind = 'sync';
    }
  }
  return kind;
}

const messageBaseDisposable =
  '`Disposable` values must be bound via `using`, returned, or otherwise handled.';

const messageBaseDisposableVoid =
  '`Disposable` values must be bound via `using`, returned, otherwise handled,' +
  ' or be explicitly marked as ignored with the `void` operator.';

const messageBaseAsyncDisposable =
  '`AsyncDisposable` values must be bound via `await using`, returned, or otherwise handled.';

const messageBaseAsyncDisposableVoid =
  '`AsyncDisposable` values must be bound via `await using`, returned, otherwise handled,' +
  ' or be explicitly marked as ignored with the `void` operator.';

export default createRule<Options, MessageId>({
  name: 'no-misused-disposable',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require `Disposable`/`AsyncDisposable` values to be bound via `using` or otherwise handled',
      requiresTypeChecking: true,
    },
    hasSuggestions: true,
    messages: {
      asyncMemberInSyncDisposableClass:
        '`AsyncDisposable` member `{{memberName}}` cannot be released by sync `[Symbol.dispose]()` on `{{className}}`. Implement `[Symbol.asyncDispose]()` instead.',
      classMemberNotDisposed:
        '`{{kind}}Disposable` member `{{memberName}}` is never disposed in `[Symbol.{{disposeKey}}]()`. Call `this.{{memberName}}[Symbol.{{disposeKey}}]()`, transfer ownership (e.g. `stack.use(this.{{memberName}})`), or remove the field.',
      classWithDisposableMemberNotDisposable:
        'Class `{{className}}` has a `{{kind}}Disposable` member `{{memberName}}` but does not implement `[Symbol.{{disposeKey}}]()`. The held resource will leak when the instance is discarded.',
      floatingAsyncDisposable: messageBaseAsyncDisposable,
      floatingAsyncDisposableVoid: messageBaseAsyncDisposableVoid,
      floatingDisposable: messageBaseDisposable,
      floatingDisposableVoid: messageBaseDisposableVoid,
      floatingFixAwaitUsing: 'Bind to an `await using` declaration.',
      floatingFixUsing: 'Bind to a `using` declaration.',
      floatingFixVoid: 'Add `void` operator to ignore.',
      useDeclarationShouldBeAwaitUsing:
        '`AsyncDisposable` value should be declared with `await using` instead of `{{kind}}`.',
      useDeclarationShouldBeUsing:
        '`Disposable` value should be declared with `using` instead of `{{kind}}`.',
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          allowForKnownSafeCalls: {
            ...readonlynessOptionsSchema.properties.allow,
            description:
              'Type specifiers of functions whose calls are safe to float.',
          },
          allowForKnownSafeDisposables: {
            ...readonlynessOptionsSchema.properties.allow,
            description:
              'Type specifiers of disposable types that are safe to float.',
          },
          checkClassMembers: {
            type: 'string',
            enum: ['off', 'shape', 'shape-and-dispose'],
            description:
              'Whether to also check class fields for disposable misuse. ' +
              '`shape` requires classes that hold disposable members to implement ' +
              '`[Symbol.dispose]`/`[Symbol.asyncDispose]`. ' +
              '`shape-and-dispose` additionally requires the dispose method to ' +
              'release each disposable member. Default `off`.',
          },
          ignoreVoid: {
            type: 'boolean',
            description: 'Whether to ignore `void` expressions.',
          },
        },
      },
    ],
  },
  defaultOptions: [
    {
      allowForKnownSafeCalls: readonlynessOptionsDefaults.allow,
      allowForKnownSafeDisposables: readonlynessOptionsDefaults.allow,
      checkClassMembers: 'off',
      ignoreVoid: true,
    },
  ],

  create(context, [options]) {
    const services = getParserServices(context);
    const checker = services.program.getTypeChecker();

    // TODO: #5439
    /* eslint-disable @typescript-eslint/no-non-null-assertion */
    const allowForKnownSafeCalls = options.allowForKnownSafeCalls!;
    const allowForKnownSafeDisposables = options.allowForKnownSafeDisposables!;
    /* eslint-enable @typescript-eslint/no-non-null-assertion */
    const checkClassMembers = options.checkClassMembers ?? 'off';

    interface DisposableFieldRecord {
      isCallerOwned: boolean;
      kind: 'async' | 'sync';
      name: string;
      reportNode: TSESTree.Node;
    }

    interface ClassFrame {
      asyncDisposeMethod?: TSESTree.MethodDefinition;
      classDisposableKind: DisposableKind;
      className: string;
      disposableFields: DisposableFieldRecord[];
      node: TSESTree.ClassDeclaration | TSESTree.ClassExpression;
      syncDisposeMethod?: TSESTree.MethodDefinition;
    }

    const classStack: ClassFrame[] = [];

    function enterClass(
      node: TSESTree.ClassDeclaration | TSESTree.ClassExpression,
    ): void {
      if (checkClassMembers === 'off' || node.declare) {
        return;
      }
      classStack.push(buildClassFrame(node));
    }

    function exitClass(
      node: TSESTree.ClassDeclaration | TSESTree.ClassExpression,
    ): void {
      if (checkClassMembers === 'off' || node.declare) {
        return;
      }
      const frame = classStack.pop();
      if (frame == null || frame.node !== node) {
        return;
      }
      runClassMemberChecks(frame);
    }

    return {
      ClassDeclaration: enterClass,
      'ClassDeclaration:exit': exitClass,
      ClassExpression: enterClass,
      'ClassExpression:exit': exitClass,

      ExpressionStatement(node): void {
        const expression = skipChainExpression(node.expression);

        if (isKnownSafeCall(expression)) {
          return;
        }

        const kind = getUnhandledDisposableKind(expression);
        if (kind == null) {
          return;
        }

        const isAsync = kind === 'async';

        if (options.ignoreVoid) {
          context.report({
            node,
            messageId: isAsync
              ? 'floatingAsyncDisposableVoid'
              : 'floatingDisposableVoid',
            suggest: [
              {
                messageId: 'floatingFixVoid',
                fix(fixer): TSESLint.RuleFix | TSESLint.RuleFix[] {
                  if (
                    isParenthesized(expression, context.sourceCode) ||
                    getOperatorPrecedenceForNode(expression) >
                      OperatorPrecedence.Unary
                  ) {
                    return fixer.insertTextBefore(node, 'void ');
                  }
                  return [
                    fixer.insertTextBefore(node, 'void ('),
                    fixer.insertTextAfterRange(
                      [expression.range[1], expression.range[1]],
                      ')',
                    ),
                  ];
                },
              },
            ],
          });
        } else {
          context.report({
            node,
            messageId: isAsync
              ? 'floatingAsyncDisposable'
              : 'floatingDisposable',
          });
        }
      },

      VariableDeclaration(node): void {
        if (
          node.kind !== 'const' &&
          node.kind !== 'let' &&
          node.kind !== 'var'
        ) {
          return;
        }

        // Only consider statement-level declarations. Skip loop inits,
        // export declarations, and other contexts where the value trivially
        // escapes or where `using`/`await using` has different semantics.
        const parent = node.parent;
        if (
          parent.type !== AST_NODE_TYPES.BlockStatement &&
          parent.type !== AST_NODE_TYPES.Program &&
          parent.type !== AST_NODE_TYPES.StaticBlock &&
          parent.type !== AST_NODE_TYPES.SwitchCase
        ) {
          return;
        }

        for (const declarator of node.declarations) {
          const init = declarator.init;
          if (init == null) {
            continue;
          }

          // Destructuring patterns bind to sub-values; skip for MVP.
          if (declarator.id.type !== AST_NODE_TYPES.Identifier) {
            continue;
          }

          // Aliasing: `const x = y` — `y` already owns disposal.
          if (init.type === AST_NODE_TYPES.Identifier) {
            continue;
          }

          const unwrapped = skipChainExpression(init);
          if (isKnownSafeCall(unwrapped)) {
            continue;
          }

          const tsInit = services.esTreeNodeToTSNodeMap.get(init);
          const type = checker.getTypeAtLocation(tsInit);

          if (isKnownSafeDisposableType(type)) {
            continue;
          }

          const kind = getDisposableKind(type, checker);
          if (kind == null) {
            continue;
          }

          // If any read reference of the declared binding reaches a destination
          // that still carries a `Disposable`/`AsyncDisposable` type, treat it
          // as an ownership transfer and skip the report.
          const declaredVars =
            context.sourceCode.getDeclaredVariables(declarator);
          if (
            declaredVars.some(v =>
              v.references.some(
                ref =>
                  isExplicitDisposeCall(ref) ||
                  isIteratorReturnCall(ref) ||
                  doesReferenceEscape(ref),
              ),
            )
          ) {
            continue;
          }

          const isAsync = kind === 'async';

          context.report({
            node: declarator,
            messageId: isAsync
              ? 'useDeclarationShouldBeAwaitUsing'
              : 'useDeclarationShouldBeUsing',
            data: { kind: node.kind },
            // Only offer a suggestion when there's a single declarator:
            // converting `const a = foo(), b = bar()` to `using a = foo(), b = bar()`
            // may incorrectly re-scope the second binding.
            ...(node.declarations.length === 1
              ? {
                  suggest: [
                    {
                      messageId: isAsync
                        ? 'floatingFixAwaitUsing'
                        : 'floatingFixUsing',
                      fix(fixer): TSESLint.RuleFix {
                        const kindToken = nullThrows(
                          context.sourceCode.getFirstToken(node),
                          NullThrowsReasons.MissingToken(
                            node.kind,
                            'variable declaration',
                          ),
                        );
                        return fixer.replaceText(
                          kindToken,
                          isAsync ? 'await using' : 'using',
                        );
                      },
                    },
                  ],
                }
              : {}),
          });
        }
      },
    };

    function isKnownSafeCall(node: TSESTree.Node): boolean {
      if (node.type !== AST_NODE_TYPES.CallExpression) {
        return false;
      }

      // Built-in `DisposableStack`/`AsyncDisposableStack` transfer methods:
      // `use(value)` and `adopt(value, onDispose)` both return their `value`
      // argument, so a bare `stack.use(makeResource())` statement has a
      // `Disposable` return type even though ownership has already been
      // transferred to the stack.
      if (
        node.callee.type === AST_NODE_TYPES.MemberExpression &&
        node.callee.property.type === AST_NODE_TYPES.Identifier &&
        (node.callee.property.name === 'use' ||
          node.callee.property.name === 'adopt')
      ) {
        const objectType = services.getTypeAtLocation(node.callee.object);
        if (
          isBuiltinSymbolLike(services.program, objectType, [
            'DisposableStack',
            'AsyncDisposableStack',
          ])
        ) {
          return true;
        }
      }

      const type = services.getTypeAtLocation(node.callee);

      if (
        valueMatchesSomeSpecifier(
          node.callee,
          allowForKnownSafeCalls,
          services.program,
          type,
        )
      ) {
        return true;
      }

      return typeMatchesSomeSpecifier(
        type,
        allowForKnownSafeCalls,
        services.program,
      );
    }

    function isKnownSafeDisposableType(type: ts.Type): boolean {
      return typeMatchesSomeSpecifier(
        type,
        allowForKnownSafeDisposables,
        services.program,
      );
    }

    // A reference of the form `x[Symbol.dispose]()` or
    // `x[Symbol.asyncDispose]()` disposes the binding in-place — the resource
    // is released, not leaked. Match this syntactically so we don't have to
    // resolve the well-known symbol at the type-checker level.
    //
    // `(Async)DisposableStack` also exposes a *named* `dispose()` method that
    // is the canonical close form for the stack itself; recognize it when the
    // receiver type is one of those built-ins.
    function isExplicitDisposeCallOnNode(node: TSESTree.Node): boolean {
      const member = node.parent;
      if (
        member?.type !== AST_NODE_TYPES.MemberExpression ||
        member.object !== node
      ) {
        return false;
      }
      const call = member.parent;
      if (
        call?.type !== AST_NODE_TYPES.CallExpression ||
        call.callee !== member
      ) {
        return false;
      }
      if (member.computed) {
        const prop = member.property;
        return (
          prop.type === AST_NODE_TYPES.MemberExpression &&
          !prop.computed &&
          prop.object.type === AST_NODE_TYPES.Identifier &&
          prop.object.name === 'Symbol' &&
          prop.property.type === AST_NODE_TYPES.Identifier &&
          (prop.property.name === 'dispose' ||
            prop.property.name === 'asyncDispose')
        );
      }
      // Non-computed: `DisposableStack#dispose()` and `AsyncDisposableStack#disposeAsync()`
      // are the canonical close forms for those built-ins (named methods alongside
      // the well-known symbols).
      if (member.property.type !== AST_NODE_TYPES.Identifier) {
        return false;
      }
      const receiverType = services.getTypeAtLocation(node);
      if (
        member.property.name === 'dispose' &&
        isBuiltinSymbolLike(services.program, receiverType, ['DisposableStack'])
      ) {
        return true;
      }
      if (
        member.property.name === 'disposeAsync' &&
        isBuiltinSymbolLike(services.program, receiverType, [
          'AsyncDisposableStack',
        ])
      ) {
        return true;
      }
      return false;
    }

    function isExplicitDisposeCall(ref: TSESLint.Scope.Reference): boolean {
      return ref.isRead() && isExplicitDisposeCallOnNode(ref.identifier);
    }

    // A reference of the form `gen.return()` on an iterator/async-iterator
    // disposes the binding in-place. The TC39 explicit-resource-management
    // proposal defines `(Async)Generator[Symbol.(async)Dispose]` to call
    // `return(undefined)`, so a direct `.return()` is the same protocol —
    // and it's the idiomatic way users close generators today.
    function isIteratorReturnCallOnNode(node: TSESTree.Node): boolean {
      const member = node.parent;
      if (
        member?.type !== AST_NODE_TYPES.MemberExpression ||
        member.object !== node ||
        member.computed ||
        member.property.type !== AST_NODE_TYPES.Identifier ||
        member.property.name !== 'return'
      ) {
        return false;
      }
      const call = member.parent;
      if (
        call?.type !== AST_NODE_TYPES.CallExpression ||
        call.callee !== member
      ) {
        return false;
      }
      const objectType = services.getTypeAtLocation(node);
      for (const part of tsutils.unionConstituents(
        checker.getApparentType(objectType),
      )) {
        if (
          tsutils.getWellKnownSymbolPropertyOfType(part, 'iterator', checker) !=
            null ||
          tsutils.getWellKnownSymbolPropertyOfType(
            part,
            'asyncIterator',
            checker,
          ) != null
        ) {
          return true;
        }
      }
      return false;
    }

    function isIteratorReturnCall(ref: TSESLint.Scope.Reference): boolean {
      return ref.isRead() && isIteratorReturnCallOnNode(ref.identifier);
    }

    // Aggregate "this `this.foo` MemberExpression read counts as disposal
    // of the underlying field" check, used by Check 2 of class-member tracking.
    function isMemberExpressionHandled(
      member: TSESTree.MemberExpression,
    ): boolean {
      return (
        isExplicitDisposeCallOnNode(member) ||
        isIteratorReturnCallOnNode(member) ||
        walkEscape(member)
      );
    }

    // A reference is treated as an ownership transfer when it reaches a
    // destination whose type still carries `Disposable`/`AsyncDisposable`.
    // Non-disposable destinations (e.g. `console.log(x: unknown)`) leave the
    // resource orphaned, so they are not treated as escape.
    function doesReferenceEscape(ref: TSESLint.Scope.Reference): boolean {
      return ref.isRead() && walkEscape(ref.identifier);
    }

    // Same parent-walk as `doesReferenceEscape`, but anchored on an arbitrary
    // node — used to ask "does this `this.foo` MemberExpression escape?"
    // when classifying class-member reads inside a dispose method.
    function walkEscape(start: TSESTree.Node): boolean {
      let node: TSESTree.Node = start;
      let parent = node.parent as TSESTree.Node | undefined;
      while (parent) {
        switch (parent.type) {
          // Transparent wrappers — keep walking up.
          case AST_NODE_TYPES.ChainExpression:
          case AST_NODE_TYPES.ConditionalExpression:
          case AST_NODE_TYPES.LogicalExpression:
          case AST_NODE_TYPES.SequenceExpression:
          case AST_NODE_TYPES.TSAsExpression:
          case AST_NODE_TYPES.TSNonNullExpression:
          case AST_NODE_TYPES.TSSatisfiesExpression:
          case AST_NODE_TYPES.TSTypeAssertion:
            node = parent;
            parent = parent.parent;
            continue;

          case AST_NODE_TYPES.ReturnStatement: {
            const fn = getParentFunctionNode(parent);
            if (fn == null) {
              return false;
            }
            return preservesDisposableKind(getReturnType(fn));
          }

          case AST_NODE_TYPES.ArrowFunctionExpression: {
            // Only implicit-return position matters; parameter defaults don't escape.
            if (parent.body !== node) {
              return false;
            }
            return preservesDisposableKind(getReturnType(parent));
          }

          case AST_NODE_TYPES.CallExpression:
          case AST_NODE_TYPES.NewExpression: {
            if (parent.callee === node) {
              return false;
            }
            const argIndex = parent.arguments.indexOf(
              node as TSESTree.CallExpressionArgument,
            );
            if (argIndex < 0) {
              return false;
            }
            const tsCall = services.esTreeNodeToTSNodeMap.get(parent);
            return preservesDisposableKind(
              checker.getContextualTypeForArgumentAtIndex(tsCall, argIndex),
            );
          }

          case AST_NODE_TYPES.AssignmentExpression: {
            if (parent.right !== node) {
              return false;
            }
            return preservesDisposableKind(
              services.getTypeAtLocation(parent.left),
            );
          }

          case AST_NODE_TYPES.Property: {
            if (parent.value !== node) {
              return false;
            }
            const tsNode = services.esTreeNodeToTSNodeMap.get(
              node,
            ) as ts.Expression;
            return preservesDisposableKind(checker.getContextualType(tsNode));
          }

          case AST_NODE_TYPES.ArrayExpression: {
            const tsNode = services.esTreeNodeToTSNodeMap.get(
              node,
            ) as ts.Expression;
            return preservesDisposableKind(checker.getContextualType(tsNode));
          }

          case AST_NODE_TYPES.VariableDeclarator: {
            if (parent.init !== node) {
              return false;
            }
            return preservesDisposableKind(
              services.getTypeAtLocation(parent.id),
            );
          }

          case AST_NODE_TYPES.ForOfStatement:
            // `for await (const y of x)` auto-disposes `x`'s async iterator
            // via IteratorClose when the body exits (ES2024). Plain
            // `for (... of ...)` doesn't carry that guarantee.
            return parent.right === node && parent.await;

          // Rare/deferred escape positions — treat permissively.
          case AST_NODE_TYPES.SpreadElement:
          case AST_NODE_TYPES.ThrowStatement:
          case AST_NODE_TYPES.YieldExpression:
            return true;

          default:
            return false;
        }
      }
      return false;
    }

    function getReturnType(
      fn:
        | TSESTree.ArrowFunctionExpression
        | TSESTree.FunctionDeclaration
        | TSESTree.FunctionExpression,
    ): ts.Type | undefined {
      const fnType = services.getTypeAtLocation(fn);
      const returnType = fnType.getCallSignatures().at(0)?.getReturnType();
      if (returnType == null) {
        return undefined;
      }
      // Unwrap `Promise<T>` for async functions — `return x` returns `T`.
      if (fn.async) {
        return checker.getAwaitedType(returnType) ?? returnType;
      }
      return returnType;
    }

    function preservesDisposableKind(t: ts.Type | undefined): boolean {
      // Ambiguous context (unknown callee, missing contextual type): permit.
      if (t == null) {
        return true;
      }
      return getDisposableKind(t, checker) != null;
    }

    function getUnhandledDisposableKind(node: TSESTree.Node): DisposableKind {
      // Bare references to existing bindings don't produce new disposable
      // values — their disposal is the owning binding's responsibility.
      if (
        node.type === AST_NODE_TYPES.Identifier ||
        node.type === AST_NODE_TYPES.MemberExpression ||
        node.type === AST_NODE_TYPES.ThisExpression
      ) {
        return null;
      }

      if (node.type === AST_NODE_TYPES.AssignmentExpression) {
        return null;
      }

      if (node.type === AST_NODE_TYPES.SequenceExpression) {
        for (const expr of node.expressions) {
          const sub = getUnhandledDisposableKind(expr);
          if (sub != null) {
            return sub;
          }
        }
        return null;
      }

      if (
        !options.ignoreVoid &&
        node.type === AST_NODE_TYPES.UnaryExpression &&
        node.operator === 'void'
      ) {
        return getUnhandledDisposableKind(node.argument);
      }

      if (node.type === AST_NODE_TYPES.ConditionalExpression) {
        return (
          getUnhandledDisposableKind(node.alternate) ??
          getUnhandledDisposableKind(node.consequent)
        );
      }

      if (node.type === AST_NODE_TYPES.LogicalExpression) {
        return (
          getUnhandledDisposableKind(node.left) ??
          getUnhandledDisposableKind(node.right)
        );
      }

      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      const type = checker.getTypeAtLocation(tsNode);

      if (isKnownSafeDisposableType(type)) {
        return null;
      }

      return getDisposableKind(type, checker);
    }

    // ---- class-member tracking ----------------------------------------

    function getMemberKeyName(key: TSESTree.Node): string | null {
      if (key.type === AST_NODE_TYPES.Identifier) {
        return key.name;
      }
      if (key.type === AST_NODE_TYPES.PrivateIdentifier) {
        return `#${key.name}`;
      }
      if (
        key.type === AST_NODE_TYPES.Literal &&
        typeof key.value === 'string'
      ) {
        return key.value;
      }
      return null;
    }

    function getDisposeMethodKind(
      method: TSESTree.MethodDefinition,
    ): DisposableKind {
      if (!method.computed) {
        return null;
      }
      const key = method.key;
      if (
        key.type !== AST_NODE_TYPES.MemberExpression ||
        key.computed ||
        key.object.type !== AST_NODE_TYPES.Identifier ||
        key.object.name !== 'Symbol' ||
        key.property.type !== AST_NODE_TYPES.Identifier
      ) {
        return null;
      }
      if (key.property.name === 'asyncDispose') {
        return 'async';
      }
      if (key.property.name === 'dispose') {
        return 'sync';
      }
      return null;
    }

    function buildClassFrame(
      node: TSESTree.ClassDeclaration | TSESTree.ClassExpression,
    ): ClassFrame {
      const className = node.id?.name ?? '<anonymous class>';
      const classType = services.getTypeAtLocation(node);
      const instanceType =
        classType.getConstructSignatures().at(0)?.getReturnType() ?? classType;
      const classDisposableKind = getDisposableKind(instanceType, checker);

      const disposableFields: DisposableFieldRecord[] = [];
      let syncDisposeMethod: TSESTree.MethodDefinition | undefined;
      let asyncDisposeMethod: TSESTree.MethodDefinition | undefined;

      for (const member of node.body.body) {
        if (
          member.type === AST_NODE_TYPES.PropertyDefinition ||
          member.type === AST_NODE_TYPES.AccessorProperty
        ) {
          if (member.static) {
            continue;
          }
          const name = getMemberKeyName(member.key);
          if (name == null) {
            continue;
          }
          const kind = getDisposableKind(
            services.getTypeAtLocation(member),
            checker,
          );
          if (kind == null) {
            continue;
          }
          disposableFields.push({
            isCallerOwned: false,
            kind,
            name,
            reportNode: member,
          });
          continue;
        }
        if (member.type !== AST_NODE_TYPES.MethodDefinition) {
          continue;
        }
        if (member.kind === 'constructor') {
          for (const param of member.value.params) {
            if (param.type !== AST_NODE_TYPES.TSParameterProperty) {
              continue;
            }
            const inner =
              param.parameter.type === AST_NODE_TYPES.AssignmentPattern
                ? param.parameter.left
                : param.parameter;
            if (inner.type !== AST_NODE_TYPES.Identifier) {
              continue;
            }
            const kind = getDisposableKind(
              services.getTypeAtLocation(inner),
              checker,
            );
            if (kind == null) {
              continue;
            }
            disposableFields.push({
              isCallerOwned: true,
              kind,
              name: inner.name,
              reportNode: param,
            });
          }
          continue;
        }
        if (member.static) {
          continue;
        }
        const disposeKind = getDisposeMethodKind(member);
        if (disposeKind === 'sync') {
          syncDisposeMethod = member;
        } else if (disposeKind === 'async') {
          asyncDisposeMethod = member;
        }
      }

      return {
        asyncDisposeMethod,
        classDisposableKind,
        className,
        disposableFields,
        node,
        syncDisposeMethod,
      };
    }

    function runClassMemberChecks(frame: ClassFrame): void {
      const ownedFields = frame.disposableFields.filter(f => !f.isCallerOwned);
      if (ownedFields.length === 0) {
        return;
      }

      // Check 1 — class shape.
      if (frame.classDisposableKind == null) {
        for (const field of ownedFields) {
          context.report({
            node: field.reportNode,
            messageId: 'classWithDisposableMemberNotDisposable',
            data: {
              className: frame.className,
              disposeKey: field.kind === 'async' ? 'asyncDispose' : 'dispose',
              kind: field.kind === 'async' ? 'Async' : '',
              memberName: field.name,
            },
          });
        }
        return;
      }
      if (frame.classDisposableKind === 'sync') {
        for (const field of ownedFields) {
          if (field.kind === 'async') {
            context.report({
              node: field.reportNode,
              messageId: 'asyncMemberInSyncDisposableClass',
              data: {
                className: frame.className,
                memberName: field.name,
              },
            });
          }
        }
      }

      // Check 2 — member disposed inside dispose method body.
      if (checkClassMembers !== 'shape-and-dispose') {
        return;
      }
      for (const field of ownedFields) {
        if (frame.classDisposableKind === 'sync' && field.kind === 'async') {
          // Already reported by Check 1's async-in-sync; don't double up.
          continue;
        }
        const candidates: TSESTree.MethodDefinition[] = [];
        if (frame.asyncDisposeMethod != null) {
          candidates.push(frame.asyncDisposeMethod);
        }
        if (field.kind === 'sync' && frame.syncDisposeMethod != null) {
          candidates.push(frame.syncDisposeMethod);
        }
        if (candidates.length === 0) {
          continue;
        }
        const handled = candidates.some(method =>
          isFieldHandledInMethod(method, field.name, frame.node),
        );
        if (!handled) {
          context.report({
            node: field.reportNode,
            messageId: 'classMemberNotDisposed',
            data: {
              disposeKey: field.kind === 'async' ? 'asyncDispose' : 'dispose',
              kind: field.kind === 'async' ? 'Async' : '',
              memberName: field.name,
            },
          });
        }
      }
    }

    function isFieldHandledInMethod(
      method: TSESTree.MethodDefinition,
      fieldName: string,
      classNode: TSESTree.ClassDeclaration | TSESTree.ClassExpression,
    ): boolean {
      if (method.value.body == null) {
        return false;
      }
      let handled = false;
      walkPreservingThis(method.value.body, classNode, node => {
        if (handled) {
          return;
        }
        if (
          node.type === AST_NODE_TYPES.MemberExpression &&
          node.object.type === AST_NODE_TYPES.ThisExpression &&
          getMemberKeyName(node.property) === fieldName &&
          isMemberExpressionHandled(node)
        ) {
          handled = true;
        }
      });
      return handled;
    }

    // Walks `start`'s subtree, skipping descendants whose `this` differs from
    // the class instance (regular function bodies, inner class bodies). Arrow
    // functions inherit `this`, so we recurse into them.
    function walkPreservingThis(
      start: TSESTree.Node,
      classNode: TSESTree.ClassDeclaration | TSESTree.ClassExpression,
      visit: (n: TSESTree.Node) => void,
    ): void {
      const worklist: TSESTree.Node[] = [start];
      while (worklist.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const node = worklist.pop()!;
        visit(node);
        if (
          node.type === AST_NODE_TYPES.FunctionDeclaration ||
          node.type === AST_NODE_TYPES.FunctionExpression
        ) {
          continue;
        }
        if (
          (node.type === AST_NODE_TYPES.ClassDeclaration ||
            node.type === AST_NODE_TYPES.ClassExpression) &&
          node !== classNode
        ) {
          continue;
        }
        for (const key of Object.keys(node) as (keyof typeof node)[]) {
          if (
            key === 'parent' ||
            key === 'loc' ||
            key === 'range' ||
            key === 'type'
          ) {
            continue;
          }
          const value: unknown = node[key];
          if (Array.isArray(value)) {
            for (const child of value) {
              if (
                child != null &&
                typeof child === 'object' &&
                'type' in (child as object)
              ) {
                worklist.push(child as TSESTree.Node);
              }
            }
          } else if (
            value != null &&
            typeof value === 'object' &&
            'type' in (value as object)
          ) {
            worklist.push(value as TSESTree.Node);
          }
        }
      }
    }
  },
});
