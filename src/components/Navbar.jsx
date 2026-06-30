import React from 'react'
import { ShoppingOutlined } from '@ant-design/icons'

export default function Navbar() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: '100%' }}>
      <ShoppingOutlined style={{ fontSize: 22, color: '#1677ff' }} />
      <span style={{ fontSize: 18, fontWeight: 600, color: '#1f2937' }}>
        Grocery AI
      </span>
    </div>
  )
}
