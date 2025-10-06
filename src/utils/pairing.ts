export type Pair = string[]; // 1/2/3 คน

export function makePairs(uids: string[], allowTriple = true): Pair[] {
  const arr = [...uids];

  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }

  const pairs: Pair[] = [];
  for (let i = 0; i < arr.length; ) {
    if (arr.length - i === 3 && allowTriple) {
      pairs.push([arr[i]!, arr[i + 1]!, arr[i + 2]!]);
      i += 3;
    } else if (i === arr.length - 1) {
      pairs.push([arr[i]!]); // บาย
      i += 1;
    } else {
      pairs.push([arr[i]!, arr[i + 1]!]);
      i += 2;
    }
  }
  return pairs;
}
