import React, { FC } from 'react';

import styles from './Loader.module.scss';

const Loader: FC = () => (
  <div className={styles.loader}>
    <div className={styles.dots}>
      {[1, 2, 3].map((it) => (
        <div key={it} className={styles.dot} />
      ))}
    </div>
  </div>
);

export { Loader };
