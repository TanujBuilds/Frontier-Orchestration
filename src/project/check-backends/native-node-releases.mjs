const licenseSha256='5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace';
const patchSha256='840109e32a582faf92ed07f75987c6eb03c9b5659cf74b2f5231ac1e72594741';

export const NATIVE_NODE_RELEASES=Object.freeze({
 '24.22.0':Object.freeze({
  version:'24.22.0',
  sourceUrl:'https://nodejs.org/dist/v24.22.0/node-v24.22.0.tar.xz',
  sourceSha256:'41f97cff2c666f1f8293dc5f85c65e8dd605c16b43fd9febd49ede32ee1e0329',
  archiveSha256:'6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5',
  coordinatorSha256:'b468fb9c67427c9d3aec07ee1105e63020923a631a9a2a00beb71a7ba3768bfd',
  licenseSha256,patchSha256
 }),
 '24.22.3':Object.freeze({
  version:'24.22.3',
  sourceUrl:'https://nodejs.org/dist/v24.22.3/node-v24.22.3.tar.xz',
  sourceSha256:'48ca3aa8a9b02133356922ef4fc80200e00598c80a4ef446f7c39a459222593d',
  archiveSha256:'ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd',
  coordinatorSha256:'ba7073582822078d8c90bca3facacc46690bc5366fab4b815aeef9148cd6e854',
  checkSha256:'59cbb026a9e3f4eda74b7cbdb5d959356fb30d8b8d56dca9f391b92f6d678aa2',
  licenseSha256,patchSha256
 })
});

export const CURRENT_NODE_RELEASE=NATIVE_NODE_RELEASES['24.22.3'];
