import {Console} from 'node:console';
import {Writable} from 'node:stream';

// Public-API oracle: a long ASCII key fixes the index column at 2048 cells.
// The target key is printed literally; remaining right padding supplies its width.
export function consoleCells(text){
 if(/[\r\n│]/u.test(text))throw Error('oracle requires a single-line key without a table separator');
 const sentinel='x'.repeat(2048);
 if(text===sentinel)throw Error('oracle sentinel collision');
 let output='';
 const stdout=new Writable({write(chunk,_encoding,done){output+=chunk;done();}});
 new Console({stdout,colorMode:false}).table({[text]:null,[sentinel]:null});
 const row=output.split('\n').find(line=>line.startsWith('│ '+text)&&line.endsWith('│ null   │'));
 if(!row)throw Error('Console.table oracle row was not literal: '+JSON.stringify(text));
 const field=row.split('│')[1],padding=field.slice(1+text.length);
 if(!/^ +$/u.test(padding))throw Error('unexpected oracle padding');
 return 2048-(padding.length-1);
}

export const matrix=[
 ['ASCII','A',1],['fullwidth Latin','Ａ',2],['fullwidth punctuation','！',2],
 ['ideographic space','　',2],['Han','界',2],['Hangul','가',2],['decomposed Hangul','가',2],
 ['halfwidth Katakana','ｶ',1],['combining accent','e\u0301',1],['isolated accent','\u0301',0],
 ['Devanagari spacing mark','का',2],['Devanagari virama','क्',1],
 ['emoji','😀',2],['ZWJ emoji','👩‍💻',4],['flag','🇺🇸',4],['modifier','👍🏽',4],
 ['family','👨‍👩‍👧‍👦',8],['keycap','1️⃣',1],['text pictograph','☀',1],['variation','☀️',1],
 ['zero width joiner','\u200d',0],['zero width space','\u200b',0],['soft hyphen','\u00ad',1],
 ['ambiguous','Ω',1],['rule','─',1],['ellipsis','…',1],
];
