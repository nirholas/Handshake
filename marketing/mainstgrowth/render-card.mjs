import sharp from "sharp";
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FF37C7"/><stop offset="1" stop-color="#FC72FF"/></linearGradient></defs>
<rect width="1200" height="630" fill="#131313"/>
<rect x="0" y="0" width="1200" height="630" fill="url(#g)" opacity="0.12"/>
<circle cx="170" cy="315" r="96" fill="url(#g)"/>
<text x="170" y="350" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="88" font-weight="700" fill="#fff">P</text>
<text x="320" y="285" font-family="Inter, Helvetica, Arial, sans-serif" font-size="96" font-weight="700" fill="#fff">PAIR</text>
<text x="320" y="360" font-family="Inter, Helvetica, Arial, sans-serif" font-size="44" fill="#9B9B9B">PAIR on Robinhood Chain</text>
<text x="320" y="480" font-family="Inter, Helvetica, Arial, sans-serif" font-size="40" font-weight="600" fill="#FF37C7">Swap on Uniswap</text>
<text x="1160" y="590" text-anchor="end" font-family="Inter, Helvetica, Arial, sans-serif" font-size="30" fill="#9B9B9B">mainstgrowth.com</text>
</svg>`;
await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile("og.png");
console.log("ok");
