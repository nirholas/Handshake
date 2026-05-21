import React from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { AvatarDevelop } from './components/Develop';
import { AvatarTest } from './components/Test';
import { AvatarNova } from './components/Nova';
import { AvatarCapture } from './components/Capture';

import styles from './App.module.scss';
import { ExhibitPage } from './components/Exhibit';

const router = createBrowserRouter([
  {
    path: '/',
    element: <AvatarDevelop />
  },
  {
    path: '/test',
    element: <AvatarTest />
  },
  {
    path: '/nova',
    element: <AvatarNova />
  },
  {
    path: '/capture-canvas',
    element: <AvatarCapture />
  },
  {
    path: '/exhibit',
    element: <ExhibitPage />
  }
]);

const App: React.FC = () => (
  <div className={styles.app}>
    <div className={styles.container}>
      <div className={styles.card}>
        <RouterProvider router={router} />
      </div>
    </div>
  </div>
);

export default App;
