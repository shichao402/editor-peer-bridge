import assert from 'node:assert/strict'
import test from 'node:test'
import { pathMatchesRoots, projectTypeMatches } from './pathUtils'

const hierarchy = {
  all: ['solution-a', 'solution-b'],
  'solution-a': [],
  'solution-b': []
}

test('projectTypeMatches allows all to route to specific solution types', () => {
  assert.equal(projectTypeMatches('all', ['solution-a', 'solution-b'], hierarchy), true)
})

test('projectTypeMatches allows specific solution types to route to all', () => {
  assert.equal(projectTypeMatches('solution-a', ['all'], hierarchy), true)
})

test('projectTypeMatches rejects unrelated types', () => {
  assert.equal(projectTypeMatches('solution-a', ['solution-b'], hierarchy), false)
})

test('pathMatchesRoots matches child files under peer workspace roots', () => {
  const peerRoots = [
    'D:/workspace/repo/subproject-a',
    'D:/workspace/repo/subproject-b'
  ]

  assert.equal(pathMatchesRoots('D:/workspace/repo/subproject-b/foo.cs', peerRoots), true)
  assert.equal(pathMatchesRoots('D:/workspace/repo/README.md', peerRoots), false)
})
