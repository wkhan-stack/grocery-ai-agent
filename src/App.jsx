import React from 'react'
import { Layout } from 'antd'
import Navbar from './components/Navbar'
import AgentChat from './components/AgentChat'

const { Header, Content } = Layout

function App() {
  return (
    <Layout style={{ minHeight: '100vh', background: '#fff' }}>
      <Header style={{
        background: '#fff',
        borderBottom: '1px solid #f0f0f0',
        padding: '0 24px',
        position: 'sticky',
        top: 0,
        zIndex: 100,
      }}>
        <Navbar />
      </Header>
      <Content>
        <AgentChat />
      </Content>
    </Layout>
  )
}

export default App
