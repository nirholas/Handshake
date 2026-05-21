const VISUAL_TEST_CONFIG = Object.freeze({
  zoomLevel: {
    head: 0.5,
    body: 3.0
  },
  side: {
    front: 1,
    back: -1
  },
  testUrl: 'http://localhost:3000/test',
  modelUrl: 'https://avatars.three.ws/66e42883315948a37cf82baf.glb',
  testThreshold: 1
});

function compareSnapshot(zoomLevel: number, side: number) {
  // use zoom level to rotate camera by 180 degrees
  cy.visit(
    `${VISUAL_TEST_CONFIG.testUrl}/?modelUrl=${encodeURIComponent(VISUAL_TEST_CONFIG.modelUrl)}&zoomLevel=${
      zoomLevel * side
    }`
  );

  cy.intercept(VISUAL_TEST_CONFIG.modelUrl).as('modelDownloading');
  cy.wait('@modelDownloading');

  // wait for the shadow under the avatar to build up with high wait time
  cy.wait(30000);

  const name = `avatar-zoom-${zoomLevel}-side-[${side}]`;

  // @ts-ignore
  cy.compareSnapshot({ name, testThreshold: VISUAL_TEST_CONFIG.testThreshold });
}

describe('visual', () => {
  it('compares avatar body snapshot front', () => {
    compareSnapshot(VISUAL_TEST_CONFIG.zoomLevel.body, VISUAL_TEST_CONFIG.side.front);
  });
  it('compares avatar head snapshot front', () => {
    compareSnapshot(VISUAL_TEST_CONFIG.zoomLevel.head, VISUAL_TEST_CONFIG.side.front);
  });
  it('compares avatar head snapshot back', () => {
    compareSnapshot(VISUAL_TEST_CONFIG.zoomLevel.head, VISUAL_TEST_CONFIG.side.back);
  });
});

export {};
