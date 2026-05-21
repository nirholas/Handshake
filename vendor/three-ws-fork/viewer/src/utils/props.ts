const fromEntries = (arr: Array<any>) => Object.assign({}, ...arr.map(([k, v]) => ({ [k]: v })));

export const definedProps = (obj: Object) =>
  fromEntries(
    // eslint-disable-next-line
    Object.entries(obj).filter(([k, v]) => v !== undefined)
  );
