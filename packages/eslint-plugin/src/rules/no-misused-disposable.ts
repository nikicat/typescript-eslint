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
    ignoreVoid?: boolean;
  },
];

export type MessageId =
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

    return {
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
          if (declaredVars.some(v => v.references.some(doesReferenceEscape))) {
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

    // A reference is treated as an ownership transfer when it reaches a
    // destination whose type still carries `Disposable`/`AsyncDisposable`.
    // Non-disposable destinations (e.g. `console.log(x: unknown)`) leave the
    // resource orphaned, so they are not treated as escape.
    function doesReferenceEscape(ref: TSESLint.Scope.Reference): boolean {
      if (!ref.isRead()) {
        return false;
      }
      let node: TSESTree.Node = ref.identifier;
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
  },
});
