/**
 * Copyright (c) 2015-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/* @flow */
import React from 'react';
import ErrorOverlay from '../components/ErrorOverlay';
import CloseButton from '../components/CloseButton';
import NavigationBar from '../components/NavigationBar';
import RuntimeError from './RuntimeError';
import Footer from '../components/Footer';

import type {ErrorRecord} from './RuntimeError';
import type {ErrorLocation} from '..';
import {useState} from 'react';

type Props = {|
  errorRecords: ErrorRecord[],
  close: () => void,
  editorHandler?: ?(errorLoc: ErrorLocation) => void,
|};

function RuntimeErrorContainer(
  props: Props,
): React$Element<typeof ErrorOverlay> {
  const {errorRecords, close} = props;
  const totalErrors = errorRecords.length;
  let [currentIndex, setCurrentIndex] = useState(0);

  let previous = () => {
    setCurrentIndex(currentIndex > 0 ? currentIndex - 1 : totalErrors - 1);
  };

  let next = () => {
    setCurrentIndex(currentIndex < totalErrors - 1 ? currentIndex + 1 : 0);
  };

  let shortcutHandler = (key: string) => {
    if (key === 'Escape') {
      props.close();
    } else if (key === 'ArrowLeft') {
      previous();
    } else if (key === 'ArrowRight') {
      next();
    }
  };

  return (
    <ErrorOverlay shortcutHandler={shortcutHandler}>
      <CloseButton close={close} />
      {totalErrors > 1 && (
        <NavigationBar
          currentError={currentIndex + 1}
          totalErrors={totalErrors}
          previous={previous}
          next={next}
        />
      )}
      <RuntimeError
        errorRecord={errorRecords[currentIndex]}
        editorHandler={props.editorHandler}
      />
      <Footer
        line1="This screen is visible only in development. It will not appear if the app crashes in production."
        line2="Open your browser’s developer console to further inspect this error.  Click the 'X' or hit ESC to dismiss this message."
      />
    </ErrorOverlay>
  );
}

export default RuntimeErrorContainer;
