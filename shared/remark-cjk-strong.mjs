import {attention} from 'micromark-core-commonmark';
import {classifyCharacter} from 'micromark-util-classify-character';

const cjk=/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const isCjk=code=>code!==null&&code>=0&&cjk.test(String.fromCodePoint(code));

// CommonMark treats punctuation followed by a CJK character as an intraword
// delimiter boundary. Relax only double-star flanking; retain its tokenizer,
// token offsets, nesting resolver, escapes and all other inline constructs.
const cjkStrong={
  name:'studyCjkStrong',
  resolveAll:attention.resolveAll,
  tokenize(effects,ok,nok){
    const previous=this.previous;
    let sequence;
    const delegated={...effects,exit(type){
      const token=effects.exit(type);
      if(type==='attentionSequence')sequence=token;
      return token;
    }};
    return attention.tokenize.call(this,delegated,code=>{
      if(sequence&&sequence.end.offset-sequence.start.offset===2){
        if(classifyCharacter(previous)===2&&isCjk(code))sequence._close=true;
        if(isCjk(previous)&&classifyCharacter(code)===2)sequence._open=true;
      }
      return ok(code);
    },nok);
  }
};

export default function remarkCjkStrong(){
  const data=this.data();
  (data.micromarkExtensions||(data.micromarkExtensions=[])).push({
    text:{42:cjkStrong},insideSpan:{null:[cjkStrong]}
  });
}
