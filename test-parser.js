const assert = require('node:assert/strict');
const { findDeclarations, findDefinitions } = require('./parser');

const header = `/* comments before declarations should not shift gutter lines */
namespace app {
template<class T>
class Store {
public:
  Store(T value);
  T get() const;
  void set(const T& value, int count = 2);
  void draw() const noexcept;
  void missing(int value);
  void inClass() { }
  virtual void abstract() = 0;
  void deleted() = delete;
};
class Other
{
public:
  void run(int);
};
}
`;
const source = `namespace app {
template<class T> Store<T>::Store(T value) {}
template<class T> T Store<T>::get() const { return T{}; }
template<class T> void Store<T>::set(const T& v, int n) {}
template<class T> void Store<T>::draw() const noexcept {}
void Other::run(int value) {}
}
`;
const declarations = findDeclarations(header);
const definitions = findDefinitions(source, new Set(declarations.map(x => x.className)));
const status = declarations.map(d => ({ name: d.name, implemented: definitions.has(`${d.className}::${d.key}`) }));
assert.deepEqual(status, [
  { name: 'Store', implemented: true },
  { name: 'get', implemented: true },
  { name: 'set', implemented: true },
  { name: 'draw', implemented: true },
  { name: 'missing', implemented: false },
  { name: 'run', implemented: true }
]);
assert.equal(declarations.find(d => d.name === 'missing').line, 9);


// Free functions/operators are declarations too; they do not need to be members of a class.
const cardHeader = `#pragma once
class Card { public: int value() const; };
bool operator<(const Card &lhs, const Card &rhs);
bool operator==(const Card& lhs, const Card& rhs);
std::ostream& operator<<(std::ostream& out, const Card& card);
namespace cards {
int score(const Card& card);
int missing(double weight);
}
`;
const cardSource = `#include "Card.hpp"
bool operator<(const Card &left, const Card &right) { return left.value() < right.value(); }
bool operator==(const Card& left, const Card& right) { return left.value() == right.value(); }
std::ostream& operator<<(std::ostream& out, const Card& card) { return out; }
namespace cards {
int score(const Card& c) { return c.value(); }
}
`;
const cardDeclarations = findDeclarations(cardHeader);
const cardDefinitions = findDefinitions(cardSource, new Set(cardDeclarations.map(d => d.className).filter(Boolean)));
const cardStatus = cardDeclarations.map(d => ({ name:d.name, scopeKey:d.scopeKey, implemented:cardDefinitions.has(d.scopeKey) }));
assert.deepEqual(cardStatus.filter(d => d.name !== 'value').map(d => [d.name,d.implemented]), [
  ['operator<', true],
  ['operator==', true],
  ['operator<<', true],
  ['score', true],
  ['missing', false]
]);

// Definitions can live directly in the header as well as in the paired .cpp file.
const inlineOperator = `class InlineCard {};
bool operator<(const InlineCard& a, const InlineCard& b) { return false; }
`;
const inlineDecls = findDeclarations(inlineOperator);
const inlineDefs = findDefinitions(inlineOperator, new Set(inlineDecls.map(d => d.className).filter(Boolean)));
assert.equal(inlineDecls.length, 1);
assert.equal(inlineDecls[0].scopeKey, '@operator<(const InlineCard&,const InlineCard&)');
assert.equal(inlineDefs.has(inlineDecls[0].scopeKey), true);

console.log('Parser tests passed.');
