// @flow
import type {MutableAsset} from '@parcel/types';
import {DOMParser, XMLSerializer} from '@xmldom/xmldom';

// Flow doesn't define ProcessingInstruction by default.
type ProcessingInstruction = CharacterData;

module.exports = {
  'xml-stylesheet': (node: ProcessingInstruction, asset: MutableAsset) => {
    const pseudo = new DOMParser().parseFromString(
      `<ψ ${node.data} />`,
      'application/xml',
    );

    const input = pseudo.firstChild.getAttribute('href');
    const output = asset.addURLDependency(input, {priority: 'parallel'});
    pseudo.firstChild.setAttribute('href', output);

    node.data = new XMLSerializer().serializeToString(pseudo).slice(2, -2);
  },
};
