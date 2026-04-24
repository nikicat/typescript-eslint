import type { TSESLint, TSESTree } from '@typescript-eslint/utils';
import type * as ts from 'typescript';

import { AST_NODE_TYPES } from '@typescript-eslint/utils';
import * as tsutils from 'ts-api-utils';

import type { TypeOrValueSpecifier } from '../util';

import {
  createRule,
  getOperatorPrecedenceForNode,
  getParserServices,
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
