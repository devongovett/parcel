import React, {StrictMode, Suspense, useState} from 'react';
import ReactDOM from 'react-dom';

import Tier1 from './tier1';
const DeferredTier2 =
  importDeferredForDisplay<typeof import('./tier2')>('./tier2');
const DeferredTier3 = importDeferred<typeof import('./tier3')>('./tier3');

import {deferredLoadComponent} from './utils';

const Tier2 = deferredLoadComponent(DeferredTier2);
const Tier3Instance1 = deferredLoadComponent(DeferredTier3);
const Tier3Instance2 = deferredLoadComponent(DeferredTier3);

function App() {
  const [count, setCount] = useState(0);

  return (
    <>
      <button
        onClick={() => {
          setCount(count + 1);
        }}
      >
        {count}
      </button>
      <div>App</div>
      <Tier1 />
      <Suspense fallback={<div>Loading Tier 2...</div>}>
        <Tier2 enabled />
      </Suspense>
      <Suspense fallback={<div>Loading Tier 3 instance 1...</div>}>
        <Tier3Instance1 />
      </Suspense>
      <Suspense fallback={<div>Loading Tier 3 instance 2...</div>}>
        <Tier3Instance2 />
      </Suspense>
      <div>
        Tier3Instance1 and Tier3Instance2 are{' '}
        {Tier3Instance1 === Tier3Instance2 ? 'the same' : 'different'}
      </div>
    </>
  );
}

ReactDOM.render(
  <StrictMode>
    <App />
  </StrictMode>,
  document.getElementById('app'),
);