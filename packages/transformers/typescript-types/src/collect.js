// @flow
import type {TSModuleGraph} from './TSModuleGraph';

import nullthrows from 'nullthrows';
import ts, {type EntityName} from 'typescript';
import {TSModule} from './TSModule';
import {getExportedName, isDeclaration} from './utils';

export function collect(
  moduleGraph: TSModuleGraph,
  context: any,
  sourceFile: any,
): any {
  // Factory only exists on TS >= 4.0
  const {factory = ts} = context;

  // When module definitions are nested inside each other (e.g with module augmentation),
  // we want to keep track of the hierarchy so we can associated nodes with the right module.
  const moduleStack: Array<?TSModule> = [];
  let _currentModule: ?TSModule;
  let visit = (node: any): any => {
    if (ts.isBundle(node)) {
      return factory.updateBundle(node, ts.visitNodes(node.sourceFiles, visit));
    }

    if (ts.isModuleDeclaration(node)) {
      moduleStack.push(_currentModule);
      _currentModule = new TSModule();
      moduleGraph.addModule(node.name.text, _currentModule);
    }

    if (!_currentModule) {
      return ts.visitEachChild(node, visit, context);
    }

    let currentModule = nullthrows(_currentModule);
    if (ts.isImportDeclaration(node) && node.importClause) {
      if (node.importClause.namedBindings) {
        if (node.importClause.namedBindings.elements) {
          for (let element of node.importClause.namedBindings.elements) {
            currentModule.addImport(
              element.name.text,
              node.moduleSpecifier.text,
              (element.propertyName ?? element.name).text,
            );
          }
        } else if (node.importClause.namedBindings.name) {
          currentModule.addImport(
            node.importClause.namedBindings.name.text,
            node.moduleSpecifier.text,
            '*',
          );
        }
      }

      if (node.importClause.name) {
        currentModule.addImport(
          node.importClause.name.text,
          node.moduleSpecifier.text,
          'default',
        );
      }
    }

    if (ts.isExportDeclaration(node)) {
      if (node.exportClause) {
        if (ts.isNamedExports(node.exportClause)) {
          for (let element of node.exportClause.elements) {
            const imported = (element.propertyName ?? element.name).text;
            const specifier = node.moduleSpecifier?.text;
            currentModule.addExport(element.name.text, imported, specifier);
          }
        } else if (ts.isNamespaceExport(node.exportClause)) {
          // Namespace export, e.g. export * as Something from "./something-else".
          currentModule.addExport(
            node.exportClause.name.text,
            '*',
            node.moduleSpecifier.text,
          );
        }
      } else {
        currentModule.addWildcardExport(node.moduleSpecifier.text);
      }
    }

    node = ts.visitEachChild(node, visit, context);

    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      let local = `$$parcel$import$${moduleGraph.syntheticImportCount++}`;
      let [specifier, entity] = getImportName(node.qualifier, local, factory);
      currentModule.addImport(local, node.argument.literal.text, specifier);
      return factory.createTypeReferenceNode(entity, node.typeArguments);
    }

    // Handle `export default name;`
    if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) {
      currentModule.addExport('default', node.expression.text);
    }

    if (isDeclaration(node)) {
      if (node.name) {
        currentModule.addLocal(node.name.text, node);
      }

      let name = getExportedName(node);
      if (name) {
        currentModule.addLocal(name, node);
        currentModule.addExport(name, name);
      }
    }

    if (ts.isVariableStatement(node) && node.modifiers) {
      let isExported = node.modifiers.some(
        m => m.kind === ts.SyntaxKind.ExportKeyword,
      );
      for (let v of node.declarationList.declarations) {
        currentModule.addLocal(v.name.text, v);
        if (isExported) {
          currentModule.addExport(v.name.text, v.name.text);
        }
      }
    }

    // After we finish traversing the children of a module definition,
    // we need to make sure that subsequent nodes get associated with the next-highest level module.
    if (ts.isModuleDeclaration(node)) {
      _currentModule = moduleStack.pop();
    }
    return node;
  };

  return ts.visitNode(sourceFile, visit);
}

// Traverse down an EntityName to the root identifier. Return that to use as the named import specifier,
// and collect the remaining parts into a new QualifiedName with the local replacement at the root.
// import('react').JSX.Element => import {JSX} from 'react'; JSX.Element
function getImportName(
  qualifier: ?EntityName,
  local: string,
  factory: typeof ts,
) {
  if (!qualifier) {
    return ['*', factory.createIdentifier(local)];
  }

  if (qualifier.kind === ts.SyntaxKind.Identifier) {
    return [qualifier.text, factory.createIdentifier(local)];
  }

  let [name, entity] = getImportName(qualifier.left, local, factory);
  return [name, factory.createQualifiedName(entity, qualifier.right)];
}
