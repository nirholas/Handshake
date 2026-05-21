import React from 'react';

import styles from './SettingsPanel.module.scss';

export const SettingsPanel: React.FC<React.PropsWithChildren> = ({
  children = 'Drop your content in there to test the avatar props without shrinking the canvas'
}) => (
  <div className={styles.settings}>
    <div className={styles.wrapper}>
      <h3 className={styles.title}>localhost playground</h3>
      <div className={styles.content}>{children}</div>
    </div>
  </div>
);
