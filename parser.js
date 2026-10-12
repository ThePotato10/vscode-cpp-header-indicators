'use strict';

// A deliberately conservative, lightweight C++ declaration matcher. It preserves
// character offsets while masking comments/literals so diagnostic line numbers stay valid.
function maskNonCode(source) {
  const out = source.split('');
  const blank = (i) => { if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' '; };
  let i = 0;
  while (i < source.length) {
    if (source[i] === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') blank(i++);
      continue;
    }
    if (source[i] === '/' && source[i + 1] === '*') {
      blank(i++); blank(i++);
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) blank(i++);
      if (i < source.length) { blank(i++); blank(i++); }
      continue;
    }
    if (source[i] === '"' || source[i] === "'" || (source[i] === 'R' && source[i + 1] === '"')) {
      let raw = false, quote, endMarker = null;
      if (source[i] === 'R' && source[i + 1] === '"') {
        raw = true;
        const paren = source.indexOf('(', i + 2);
        if (paren !== -1 && paren - i < 20) endMarker = ')' + source.slice(i + 2, paren) + '"';
        quote = '"';
      } else quote = source[i];
      if (raw && endMarker) {
        while (i < source.length && !source.startsWith(endMarker, i)) blank(i++);
        if (i < source.length) for (let n = 0; n < endMarker.length; n++) blank(i++);
      } else {
        blank(i++);
        while (i < source.length) {
          const c = source[i]; blank(i++);
          if (c === '\\' && i < source.length) { blank(i++); continue; }
          if (c === quote) break;
        }
      }
      continue;
    }
    i++;
  }
  // Preprocessor lines are not ordinary C++ declarations.
  let lineStart = 0;
  for (let j = 0; j <= out.length; j++) {
    if (j === out.length || out[j] === '\n') {
      const line = out.slice(lineStart, j).join('');
      if (/^\s*#/.test(line)) for (let k = lineStart; k < j; k++) blank(k);
      lineStart = j + 1;
    }
  }
  return out.join('');
}

function matching(text, open, left = '(', right = ')') {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === left) depth++;
    else if (text[i] === right && --depth === 0) return i;
  }
  return -1;
}
function lineAt(text, offset) {
  let line = 0;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}
function splitTopLevel(text, delimiter = ',') {
  const result = [];
  let start = 0, paren = 0, bracket = 0, brace = 0, angle = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') paren++;
    else if (c === ')') paren--;
    else if (c === '[') bracket++;
    else if (c === ']') bracket--;
    else if (c === '{') brace++;
    else if (c === '}') brace--;
    else if (c === '<') angle++;
    else if (c === '>' && angle > 0) angle--;
    else if (c === delimiter && paren === 0 && bracket === 0 && brace === 0 && angle === 0) {
      result.push(text.slice(start, i)); start = i + 1;
    }
  }
  result.push(text.slice(start));
  return result;
}
function normalizeType(s) {
  return s.replace(/\b(class|struct|enum)\s+/g, '')
    .replace(/\bstd::__cxx11::/g, 'std::')
    .replace(/\s+/g, ' ')
    .replace(/\s*::\s*/g, '::')
    .replace(/\s*([*&])\s*/g, '$1')
    .replace(/\s*([<>])\s*/g, '$1')
    .replace(/\s*,\s*/g, ',')
    .trim();
}
function removeDefaultValue(arg) {
  const parts = splitTopLevel(arg, '=');
  return parts[0].trim();
}
function removeParameterName(arg) {
  let s = removeDefaultValue(arg).trim();
  s = s.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
  // Function parameter packs such as Args... args.
  const pack = s.match(/^(.*\.\.\.)\s+([A-Za-z_]\w*)$/);
  if (pack) return pack[1].trim();
  const m = s.match(/^(.*?)(\s+|(?<=[*&>]))([A-Za-z_]\w*)$/);
  if (!m) return normalizeType(s);
  const prefix = (m[1] || '').trim();
  const candidate = m[3];
  if (!prefix) return normalizeType(s);
  // `const Foo` and `unsigned long` can be unnamed types, not name/type pairs.
  if (/^(const|volatile|unsigned|signed|long|short|struct|class|typename|auto)$/.test(prefix)) return normalizeType(s);
  if (/^(const|volatile|unsigned|signed|long|short)\s+(const|volatile|unsigned|signed|long|short)$/.test(prefix)) return normalizeType(s);
  // A built-in or qualified/template/pointer type followed by an identifier is a named parameter.
  const looksLikeType = /\b(void|bool|char|wchar_t|char8_t|char16_t|char32_t|short|int|long|float|double|signed|unsigned|auto|decltype)\b/.test(prefix)
    || /::|[<>*&]/.test(prefix)
    || /^[A-Za-z_]\w*$/.test(prefix)
    || /^[A-Za-z_]\w*(?:\s+[A-Za-z_]\w*)+$/.test(prefix);
  return normalizeType(looksLikeType ? prefix : s);
}
function parameterTypes(params) {
  const items = splitTopLevel(params.trim());
  if (items.length === 1 && (!items[0].trim() || /^void$/.test(items[0].trim()))) return [];
  return items.map(removeParameterName);
}
function qualifierKey(tail) {
  const upToArrow = tail.split('->')[0].split('requires')[0];
  const cv = `${/\bconst\b/.test(upToArrow) ? ' const' : ''}${/\bvolatile\b/.test(upToArrow) ? ' volatile' : ''}`;
  const ref = /&&/.test(upToArrow) ? '&&' : /&/.test(upToArrow) ? '&' : '';
  const noex = /\bnoexcept\b/.test(upToArrow) ? ' noexcept' : '';
  return cv + (ref ? ` ${ref}` : '') + noex;
}
function makeKey(name, params, tail) {
  return `${name.replace(/\s+/g, '')}(${parameterTypes(params).join(',')})${qualifierKey(tail)}`;
}
function isPlausibleTail(tail) {
  const t = tail.trim();
  return !t || /^(?:(?:const|volatile|override|final|noexcept)\b|&&?|->|requires\b|\[\[|=\s*(?:0|delete|default))/.test(t);
}
function findMethodDeclarator(stmt) {
  const clean = stmt.trim().replace(/;\s*$/, '').trim();
  if (!clean || /^(using|typedef|friend|static_assert|return|concept)\b/.test(clean)) return null;
  if (/=\s*(?:0|delete|default)\s*$/.test(clean)) return null;
  const candidates = [];
  const reserved = /^(noexcept|decltype|sizeof|alignof|typeid|requires|static_assert)$/;
  let m;

  // Operators need their own tokenization: `operator<`, `operator<<`, `operator()` etc.
  const opRe = /operator\s*(\(\)|\[\]|new\s*(?:\[\])?|delete\s*(?:\[\])?|[+\-*/%&|^~!=<>?,]+|[A-Za-z_]\w*)\s*\(/g;
  while ((m = opRe.exec(clean)) !== null) {
    const open = m.index + m[0].lastIndexOf('(');
    const close = matching(clean, open);
    if (close < 0) continue;
    const tail = clean.slice(close + 1).trim();
    if (isPlausibleTail(tail)) {
      const opName = `operator${m[1].replace(/\s+/g, '')}`;
      candidates.push({ name:opName, params:clean.slice(open + 1, close), tail, offset:m.index, operator:true });
    }
  }

  const nameRe = /(~?[A-Za-z_]\w*)\s*\(/g;
  while ((m = nameRe.exec(clean)) !== null) {
    if (reserved.test(m[1]) || m[1] === 'operator') continue;
    const open = clean.indexOf('(', m.index + m[1].length);
    const close = matching(clean, open);
    if (close < 0) continue;
    const tail = clean.slice(close + 1).trim();
    if (isPlausibleTail(tail)) candidates.push({ name:m[1], params:clean.slice(open + 1, close), tail, offset:m.index, operator:false });
  }
  if (!candidates.length || /\(\s*\*/.test(clean)) return null;
  candidates.sort((a,b) => a.offset - b.offset || Number(a.operator) - Number(b.operator));
  return candidates[candidates.length - 1];
}
function findClassBodies(masked) {
  const classes = [];
  const re = /\b(class|struct)\s+([A-Za-z_]\w*)\b/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const before = masked.slice(Math.max(0, m.index - 160), m.index);
    if (/\benum\s+$/.test(masked.slice(Math.max(0, m.index - 12), m.index))) continue;
    if (/\btemplate\s*<[^<>]*$/.test(before)) continue;
    let j = re.lastIndex, paren = 0, bracket = 0;
    for (; j < masked.length; j++) {
      const c = masked[j];
      if (c === '(') paren++; else if (c === ')') paren--;
      else if (c === '[') bracket++; else if (c === ']') bracket--;
      else if (paren === 0 && bracket === 0 && (c === ';' || c === '{')) break;
    }
    if (j >= masked.length || masked[j] !== '{') continue;
    const close = matching(masked, j, '{', '}');
    if (close < 0) continue;
    classes.push({ name:m[2], open:j, close });
    re.lastIndex = j + 1;
  }
  return classes;
}
function memberStatements(masked, open, close) {
  const statements=[];
  let start=open+1, paren=0, bracket=0;
  for (let i=open+1; i<close; i++) {
    const c=masked[i];
    if (c==='(') paren++; else if(c===')') paren--;
    else if(c==='[') bracket++; else if(c===']') bracket--;
    if (paren===0 && bracket===0 && c==='{') {
      const end=matching(masked,i,'{','}');
      if(end<0) break;
      start=end+1; i=end; continue;
    }
    if (paren===0 && bracket===0 && c===';') {
      let stmt=masked.slice(start,i).trim();
      stmt=stmt.replace(/^(?:(?:public|private|protected)\s*:\s*)+/, '').trim();
      if (stmt) statements.push({stmt, offset:start + masked.slice(start,i).search(/\S/)});
      start=i+1;
    }
  }
  return statements;
}

function scopeNameFromPrefix(prefix) {
  const m = prefix.trim().match(/^(?:(?:inline|export)\s+)*namespace\s*([A-Za-z_]\w*(?:::\s*[A-Za-z_]\w*)*)?\s*$/s);
  if (!m) return null;
  return (m[1] || '').split('::').map(x=>x.trim()).filter(Boolean);
}
function isClassOrEnumBlock(prefix) {
  return /^(?:(?:template\s*<[^;{}]*>\s*)|(?:export\s+))*\s*(?:class|struct|union|enum)\b/.test(prefix.trim());
}
function isQualifiedFunctionPrefix(prefix, method) {
  const before = prefix.slice(0, method.offset).trimEnd();
  return /(?:[A-Za-z_]\w*(?:\s*<[^<>]+>)?\s*::\s*)+$/.test(before);
}
function freeScopeKey(namespaceParts, key) {
  return `@${namespaceParts.length ? namespaceParts.join('::') + '::' : ''}${key}`;
}

// Walk only namespace/global scope. Class and function bodies are skipped so their
// semicolons cannot be mistaken for free-function declarations.
function walkFreeScope(masked, start, end, namespaceParts, onDeclaration, onDefinition) {
  let stmtStart=start, paren=0, bracket=0;
  for (let i=start; i<end; i++) {
    const c=masked[i];
    if (c==='(') { paren++; continue; }
    if (c===')') { paren=Math.max(0,paren-1); continue; }
    if (c==='[') { bracket++; continue; }
    if (c===']') { bracket=Math.max(0,bracket-1); continue; }
    if (paren!==0 || bracket!==0) continue;
    if (c===';') {
      const raw=masked.slice(stmtStart,i);
      const stmt=raw.trim();
      if (stmt) onDeclaration(stmt, stmtStart + raw.search(/\S/), namespaceParts);
      stmtStart=i+1;
      continue;
    }
    if (c==='{') {
      const prefix=masked.slice(stmtStart,i);
      const prefixTrim=prefix.trim();
      const close=matching(masked,i,'{','}');
      if (close<0 || close>=end) break;
      const nestedNamespace=scopeNameFromPrefix(prefixTrim);
      if (nestedNamespace!==null) {
        walkFreeScope(masked, i+1, close, namespaceParts.concat(nestedNamespace), onDeclaration, onDefinition);
      } else if (!isClassOrEnumBlock(prefixTrim)) {
        const method=findMethodDeclarator(prefixTrim);
        if (method && !isQualifiedFunctionPrefix(prefixTrim,method)) {
          onDefinition(prefixTrim, stmtStart + prefix.search(/\S/), namespaceParts, method);
        }
      }
      stmtStart=close+1;
      i=close;
    }
  }
  // No semicolon: ordinary declarations require one, and trailing source trivia is ignored.
}

function findDeclarations(source) {
  const masked=maskNonCode(source);
  const decls=[];
  for (const cls of findClassBodies(masked)) {
    for (const {stmt,offset} of memberStatements(masked,cls.open,cls.close)) {
      const method=findMethodDeclarator(stmt);
      if (!method) continue;
      if (/\busing\b/.test(stmt.slice(0, method.offset)) || /\btypedef\b/.test(stmt.slice(0, method.offset))) continue;
      const key=makeKey(method.name,method.params,method.tail);
      decls.push({line:lineAt(source,offset), name:method.name, key, className:cls.name, scopeKey:`${cls.name}::${key}`, offset});
    }
  }
  const addFreeFunction = (stmt, offset, namespaceParts, method) => {
    if (!method || isQualifiedFunctionPrefix(stmt,method)) return;
    if (/\b(using|typedef|friend|static_assert|concept)\b/.test(stmt.slice(0,method.offset))) return;
    const key=makeKey(method.name,method.params,method.tail);
    decls.push({line:lineAt(source,offset), name:method.name, key, className:null, namespaceName:namespaceParts.join('::'), scopeKey:freeScopeKey(namespaceParts,key), offset});
  };
  walkFreeScope(masked, 0, masked.length, [], (stmt,offset,namespaceParts) => addFreeFunction(stmt,offset,namespaceParts,findMethodDeclarator(stmt)), (prefix,offset,namespaceParts,method) => {
    // A free-function definition in a header is itself worth displaying an indicator for.
    addFreeFunction(prefix, offset, namespaceParts, method);
  });
  // Keep exact source declarations once if a parser edge case found the same declaration twice.
  const seen=new Set();
  return decls.filter(d=>{const k=`${d.offset}|${d.scopeKey}`; if(seen.has(k)) return false; seen.add(k); return true;});
}

function findDefinitions(source, classNames) {
  const masked=maskNonCode(source);
  const defs=new Set();
  // Out-of-class methods, including overloaded operators.
  const namePart = '(operator\\s*(?:\\(\\)|\\[\\]|new\\s*(?:\\[\\])?|delete\\s*(?:\\[\\])?|[+\\-*/%&|^~!=<>?,]+|[A-Za-z_]\\w*)|~?[A-Za-z_]\\w*)';
  const re = new RegExp('((?:[A-Za-z_]\\w*(?:\\s*<[^<>]*>)?\\s*::\\s*)+)' + namePart + '\\s*\\(', 'g');
  let m;
  while ((m=re.exec(masked))!==null) {
    const qualified=m[1].replace(/\s+/g,'');
    const parts=qualified.split('::').filter(Boolean);
    const owner=parts[parts.length-1].replace(/<.*$/, '');
    if (classNames && !classNames.has(owner)) continue;
    const open=masked.indexOf('(',m.index+m[0].lastIndexOf('('));
    const close=matching(masked,open);
    if(close<0) continue;
    let j=close+1, paren=0, bracket=0, angle=0, foundBody=false;
    for(;j<masked.length && j-close<700;j++){
      const c=masked[j];
      if(c==='(') paren++; else if(c===')') paren--;
      else if(c==='[') bracket++; else if(c===']') bracket--;
      else if(c==='<') angle++; else if(c==='>' && angle>0) angle--;
      else if(paren===0&&bracket===0&&angle===0&&c===';') break;
      else if(paren===0&&bracket===0&&angle===0&&c==='{'){foundBody=true;break;}
    }
    if(!foundBody) continue;
    const tail=masked.slice(close+1,j).trim();
    if(tail && !/^(?:(?:const|volatile|noexcept|override|final|&|&&|->|requires|__attribute__)\b|&&?|->)/.test(tail)) continue;
    const name=m[2].replace(/\s+/g,'');
    defs.add(`${owner}::${makeKey(name,masked.slice(open+1,close),tail)}`);
  }

  // Free functions (including free operator overloads) declared/defined at global or
  // namespace scope, in both headers and source files.
  walkFreeScope(masked, 0, masked.length, [], () => {}, (prefix, offset, namespaceParts, method) => {
    const key=makeKey(method.name,method.params,method.tail);
    defs.add(freeScopeKey(namespaceParts,key));
  });
  return defs;
}

module.exports = { maskNonCode, findDeclarations, findDefinitions, parameterTypes, makeKey };
