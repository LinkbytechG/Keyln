// Rebuild Keyln's committed raster app icons from the approved artwork in apps/web/icons/keyln.svg.
// Renders with the system SVG renderer (scripts/render-svg.swift via the Xcode command line tools);
// no npm dependencies. Run after changing keyln.svg: node scripts/generate-app-icons.mjs
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const source=readFileSync(join(root,'apps/web/icons/keyln.svg'),'utf8');
// The artwork is a 256 viewBox with an 8 px transparent margin around a rounded #1A1917 tile and its outline.
const TILE='<rect x="8" y="8" width="240" height="240" rx="32" fill="#1A1917"/>';
const OUTLINE='<rect x="8.5" y="8.5" width="239" height="239" rx="31.5" fill="none" stroke="#3A3530"/>';
const FULL='<rect width="256" height="256" fill="#1A1917"/>';
for(const part of [TILE,OUTLINE])if(source.split(part).length!==2)throw Error(`keyln.svg must contain exactly one ${part}`);
const [head,rest]=source.split(TILE);
if(!rest.trimEnd().endsWith('</svg>'))throw Error('keyln.svg must end with </svg>');
const keys=rest.replace(OUTLINE,'').trimEnd().slice(0,-'</svg>'.length);
const about=scale=>`<g transform="translate(128 128) scale(${scale}) translate(-128 -128)">`;

const variants={
  // Home screen and PWA icons are full bleed: the platform applies its own mask, so no margin or outline.
  full:head+FULL+keys+'</svg>\n',
  // Maskable: the farthest K corner is ~135 units from the centre; at 0.72 it sits ~97 < 102.4 (safe-zone radius, 40%).
  maskable:head+FULL+about(0.72)+keys+'</g></svg>\n',
  // macOS: the tile keeps its own shape and sits on Apple's icon grid (824 of 1024, i.e. 206 of 256).
  mac:head+about(206/240)+TILE+OUTLINE+keys+'</g></svg>\n',
};
const outputs=[
  ['full','apps/web/icons/keyln-180.png',180],
  ['full','apps/web/icons/keyln-192.png',192],
  ['full','apps/web/icons/keyln-512.png',512],
  ['maskable','apps/web/icons/keyln-maskable-512.png',512],
  ['mac','native/macos-menubar/AppIcon.png',1024],
];

const work=mkdtempSync(join(tmpdir(),'keyln-icons-'));
try{
  const renderer=join(work,'render-svg');
  execFileSync('/usr/bin/xcrun',['swiftc','-O','-module-cache-path',join(work,'cache'),join(root,'scripts/render-svg.swift'),'-o',renderer],{stdio:'inherit'});
  const jobs=[];
  for(const [name,svg] of Object.entries(variants)){const file=join(work,`${name}.svg`);writeFileSync(file,svg);variants[name]=file;}
  for(const [variant,output,size] of outputs)jobs.push(variants[variant],join(root,output),String(size));
  execFileSync(renderer,jobs,{stdio:'inherit'});
  for(const [,output] of outputs)console.log(output);
}finally{rmSync(work,{recursive:true,force:true});}
