'use strict'

const config = require('../../config.json')

const FEATURE_PERMISSIONS = {
  cron: 'admin',
  config: 'admin',
  opus: 'admin',
  query: 'all',
  diagnose: 'all',
}

function isAdmin(userId) {
  return (config.admins || []).includes(userId)
}

function checkPermission(userId, feature) {
  const required = FEATURE_PERMISSIONS[feature] || 'all'
  if (required === 'all') return true
  if (required === 'admin') return isAdmin(userId)
  return false
}

module.exports = { isAdmin, checkPermission }
