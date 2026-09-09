import { useEffect, useState } from 'react';

export default function App() {
  const [user, setUser] = useState(null);

  useEffect(() => {
    // Access the Telegram WebApp object
    const tg = window.Telegram?.WebApp;
    
    if (tg) {
      tg.ready();
      tg.expand(); // Expands the app to full screen height inside Telegram
      
      // Extract user details passed by Telegram
      if (tg.initDataUnsafe?.user) {
        setUser(tg.initDataUnsafe.user);
      }
    }
  }, []);

  return (
    <div style={{ 
      padding: '20px', 
      fontFamily: 'sans-serif', 
      textAlign: 'center',
      minHeight: '100vh',
      boxSizing: 'border-box'
    }}>
      <h1>🎓 Mini App Portal</h1>
      
      {user ? (
        <div style={{ 
          background: '#f4f4f5', 
          padding: '15px', 
          borderRadius: '10px', 
          margin: '20px 0',
          color: '#333' 
        }}>
          <h3>Welcome, {user.first_name}! 👋</h3>
          {user.username && <p>Username: @{user.username}</p>}
          <p>User ID: <code>{user.id}</code></p>
        </div>
      ) : (
        <p style={{ color: '#888', margin: '20px 0' }}>
          Open this app inside Telegram to view user details.
        </p>
      )}

      <button 
        onClick={() => window.Telegram?.WebApp?.close()}
        style={{
          padding: '12px 24px',
          backgroundColor: '#0088cc',
          color: '#fff',
          border: 'none',
          borderRadius: '8px',
          fontSize: '16px',
          fontWeight: 'bold',
          cursor: 'pointer'
        }}
      >
        Close App
      </button>
    </div>
  );
}
