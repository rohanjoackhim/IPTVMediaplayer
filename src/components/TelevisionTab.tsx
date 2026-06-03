import React, { useState, useEffect, useCallback } from 'react';
import './TelevisionTab.css';

interface Channel {
  id: string;
  name: string;
  url: string;
  logo?: string;
  group?: string;
  country?: string;
  language?: string;
  category?: string;
  content_type: 'live' | 'movie' | 'series';
  is_active: boolean;
}

interface ApiKey {
  id: string;
  name?: string;
  key: string;
  is_active: boolean;
  last_used_at?: string;
  created_at: string;
}

interface User {
  id: string;
  email: string;
  subscription_status: string | null;
  subscription_period: string | null;
  subscription_expires_at: string | null;
}

interface TelevisionTabProps {
  apiBaseUrl?: string;
  onChannelsLoaded?: (channels: Channel[]) => void;
}

const TelevisionTab: React.FC<TelevisionTabProps> = ({
  apiBaseUrl = 'http://localhost:3001/api',
  onChannelsLoaded,
}) => {
  const [activeTab, setActiveTab] = useState<'channels' | 'keys' | 'account'>('channels');
  const [channels, setChannels] = useState<Channel[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(localStorage.getItem('iptv_token'));
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form states
  const [showLogin, setShowLogin] = useState(!token);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);

  // Channel form
  const [showChannelForm, setShowChannelForm] = useState(false);
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
  const [channelForm, setChannelForm] = useState<{
    name: string;
    url: string;
    logo: string;
    group: string;
    country: string;
    language: string;
    category: string;
    content_type: 'live' | 'movie' | 'series';
  }>({
    name: '',
    url: '',
    logo: '',
    group: '',
    country: '',
    language: '',
    category: '',
    content_type: 'live',
  });

  // API Key input for player mode
  const [playerApiKey, setPlayerApiKey] = useState(localStorage.getItem('iptv_player_api_key') || '');
  const [isLoadingPlayerChannels, setIsLoadingPlayerChannels] = useState(false);

  const apiRequest = useCallback(async (endpoint: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers);
    headers.set('Content-Type', 'application/json');

    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    const response = await fetch(`${apiBaseUrl}${endpoint}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Request failed: ${response.status}`);
    }

    return response.json();
  }, [apiBaseUrl, token]);

  // Load user data
  useEffect(() => {
    if (!token) {
      setShowLogin(true);
      return;
    }

    setShowLogin(false);
    loadUserData();
  }, [token]);

  const loadUserData = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const [userData, channelsData, keysData] = await Promise.all([
        apiRequest('/auth/me'),
        apiRequest('/channels'),
        apiRequest('/keys'),
      ]);

      setUser(userData.user);
      setChannels(channelsData.channels || []);
      setApiKeys(keysData.apiKeys || []);
    } catch (err: any) {
      setError(err.message);
      if (err.message.includes('Unauthorized')) {
        localStorage.removeItem('iptv_token');
        setToken(null);
        setShowLogin(true);
      }
    } finally {
      setIsLoading(false);
    }
  };

  // Auth handlers
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      const data = await apiRequest('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });

      localStorage.setItem('iptv_token', data.token);
      setToken(data.token);
      setShowLogin(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      const data = await apiRequest('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });

      localStorage.setItem('iptv_token', data.token);
      setToken(data.token);
      setShowLogin(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('iptv_token');
    setToken(null);
    setUser(null);
    setChannels([]);
    setApiKeys([]);
    setShowLogin(true);
  };

  // Channel handlers
  const handleSaveChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      if (editingChannel) {
        await apiRequest(`/channels/${editingChannel.id}`, {
          method: 'PUT',
          body: JSON.stringify(channelForm),
        });
      } else {
        await apiRequest('/channels', {
          method: 'POST',
          body: JSON.stringify(channelForm),
        });
      }

      setShowChannelForm(false);
      setEditingChannel(null);
      setChannelForm({
        name: '',
        url: '',
        logo: '',
        group: '',
        country: '',
        language: '',
        category: '',
        content_type: 'live' as 'live' | 'movie' | 'series',
      });
      loadUserData();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteChannel = async (id: string) => {
    if (!confirm('Are you sure you want to delete this channel?')) return;

    setIsLoading(true);
    try {
      await apiRequest(`/channels/${id}`, { method: 'DELETE' });
      loadUserData();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleEditChannel = (channel: Channel) => {
    setEditingChannel(channel);
    setChannelForm({
      name: channel.name,
      url: channel.url,
      logo: channel.logo || '',
      group: channel.group || '',
      country: channel.country || '',
      language: channel.language || '',
      category: channel.category || '',
      content_type: channel.content_type,
    });
    setShowChannelForm(true);
  };

  // API Key handlers
  const handleCreateApiKey = async () => {
    const name = prompt('Enter a name for this API key (optional):');
    if (name === null) return;

    setIsLoading(true);
    try {
      const data = await apiRequest('/keys', {
        method: 'POST',
        body: JSON.stringify({ name: name || undefined }),
      });

      alert(`Your new API key:\n${data.apiKey}\n\nCopy this now - it won't be shown again!`);
      loadUserData();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteApiKey = async (id: string) => {
    if (!confirm('Are you sure you want to revoke this API key?')) return;

    setIsLoading(true);
    try {
      await apiRequest(`/keys/${id}`, { method: 'DELETE' });
      loadUserData();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  // Player mode - load channels with API key
  const handleLoadPlayerChannels = async () => {
    if (!playerApiKey.trim()) {
      setError('Please enter an API key');
      return;
    }

    setIsLoadingPlayerChannels(true);
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/channels/public`, {
        headers: { 'X-API-Key': playerApiKey.trim() },
      });

      if (!response.ok) {
        throw new Error('Invalid API key or no channels found');
      }

      const data = await response.json();
      localStorage.setItem('iptv_player_api_key', playerApiKey.trim());

      if (onChannelsLoaded) {
        onChannelsLoaded(data.channels || []);
      }

      setChannels(data.channels || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoadingPlayerChannels(false);
    }
  };

  // Login form
  if (showLogin) {
    return (
      <div className="television-tab">
        <div className="television-login">
          <h2>Television Provider Portal</h2>
          <p>Stream your own channels to the player</p>

          {error && <div className="television-error">{error}</div>}

          <form onSubmit={isRegistering ? handleRegister : handleLogin}>
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <input
              type="password"
              placeholder="Password (min 8 characters)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              required
            />
            <button type="submit" disabled={isLoading}>
              {isLoading ? 'Loading...' : isRegistering ? 'Create Account' : 'Sign In'}
            </button>
          </form>

          <p className="television-toggle">
            {isRegistering ? 'Already have an account?' : "Don't have an account?"}{' '}
            <button
              className="link-button"
              onClick={() => setIsRegistering(!isRegistering)}
            >
              {isRegistering ? 'Sign In' : 'Create Account'}
            </button>
          </p>

          <div className="television-player-mode">
            <h3>Have an API key?</h3>
            <p>Enter your provider's API key to load their channels:</p>
            <input
              type="text"
              placeholder="Enter API key (iptv_...)"
              value={playerApiKey}
              onChange={(e) => setPlayerApiKey(e.target.value)}
            />
            <button
              onClick={handleLoadPlayerChannels}
              disabled={isLoadingPlayerChannels}
            >
              {isLoadingPlayerChannels ? 'Loading...' : 'Load Channels'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="television-tab">
      <div className="television-header">
        <h2>Television Provider</h2>
        <div className="television-user">
          <span>{user?.email}</span>
          <button onClick={handleLogout} className="logout-btn">Logout</button>
        </div>
      </div>

      {error && <div className="television-error">{error}</div>}

      <div className="television-tabs">
        <button
          className={activeTab === 'channels' ? 'active' : ''}
          onClick={() => setActiveTab('channels')}
        >
          My Channels ({channels.length})
        </button>
        <button
          className={activeTab === 'keys' ? 'active' : ''}
          onClick={() => setActiveTab('keys')}
        >
          API Keys ({apiKeys.length})
        </button>
        <button
          className={activeTab === 'account' ? 'active' : ''}
          onClick={() => setActiveTab('account')}
        >
          Account
        </button>
      </div>

      {activeTab === 'channels' && (
        <div className="television-channels">
          <div className="television-actions">
            <button
              className="primary-btn"
              onClick={() => {
                setEditingChannel(null);
                setChannelForm({
                  name: '',
                  url: '',
                  logo: '',
                  group: '',
                  country: '',
                  language: '',
                  category: '',
                  content_type: 'live' as 'live' | 'movie' | 'series',
                });
                setShowChannelForm(true);
              }}
            >
              + Add Channel
            </button>
          </div>

          {showChannelForm && (
            <form className="channel-form" onSubmit={handleSaveChannel}>
              <h3>{editingChannel ? 'Edit Channel' : 'Add New Channel'}</h3>
              <input
                placeholder="Channel Name *"
                value={channelForm.name}
                onChange={(e) => setChannelForm({ ...channelForm, name: e.target.value })}
                required
              />
              <input
                placeholder="Stream URL (https://...) *"
                value={channelForm.url}
                onChange={(e) => setChannelForm({ ...channelForm, url: e.target.value })}
                required
              />
              <input
                placeholder="Logo URL (optional)"
                value={channelForm.logo}
                onChange={(e) => setChannelForm({ ...channelForm, logo: e.target.value })}
              />
              <input
                placeholder="Group (e.g., Sports, News)"
                value={channelForm.group}
                onChange={(e) => setChannelForm({ ...channelForm, group: e.target.value })}
              />
              <div className="form-row">
                <input
                  placeholder="Country"
                  value={channelForm.country}
                  onChange={(e) => setChannelForm({ ...channelForm, country: e.target.value })}
                />
                <input
                  placeholder="Language"
                  value={channelForm.language}
                  onChange={(e) => setChannelForm({ ...channelForm, language: e.target.value })}
                />
              </div>
              <select
                value={channelForm.content_type}
                onChange={(e) => setChannelForm({ ...channelForm, content_type: e.target.value as 'live' | 'movie' | 'series' })}
              >
                <option value="live">Live TV</option>
                <option value="movie">Movie</option>
                <option value="series">Series</option>
              </select>
              <div className="form-actions">
                <button type="submit" disabled={isLoading}>
                  {isLoading ? 'Saving...' : editingChannel ? 'Update' : 'Add'}
                </button>
                <button type="button" onClick={() => setShowChannelForm(false)}>
                  Cancel
                </button>
              </div>
            </form>
          )}

          <div className="channels-list">
            {channels.length === 0 ? (
              <p className="empty">No channels yet. Click "Add Channel" to get started.</p>
            ) : (
              channels.map((channel) => (
                <div key={channel.id} className={`channel-card ${!channel.is_active ? 'inactive' : ''}`}>
                  {channel.logo && <img src={channel.logo} alt="" className="channel-logo" />}
                  <div className="channel-info">
                    <h4>{channel.name}</h4>
                    <p className="channel-meta">
                      {channel.group && <span className="tag">{channel.group}</span>}
                      <span className="tag type">{channel.content_type}</span>
                      {!channel.is_active && <span className="tag inactive">inactive</span>}
                    </p>
                    <p className="channel-url">{channel.url}</p>
                  </div>
                  <div className="channel-actions">
                    <button onClick={() => handleEditChannel(channel)}>Edit</button>
                    <button onClick={() => handleDeleteChannel(channel.id)} className="danger">
                      Delete
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {activeTab === 'keys' && (
        <div className="television-keys">
          <div className="television-actions">
            <button className="primary-btn" onClick={handleCreateApiKey}>
              + Generate API Key
            </button>
          </div>

          <p className="info">
            Share your API key with others to let them access your channels in the player.
          </p>

          <div className="keys-list">
            {apiKeys.length === 0 ? (
              <p className="empty">No API keys yet.</p>
            ) : (
              apiKeys.map((key) => (
                <div key={key.id} className={`key-card ${!key.is_active ? 'inactive' : ''}`}>
                  <div className="key-info">
                    <code className="key-value">{key.key}</code>
                    {key.name && <p className="key-name">{key.name}</p>}
                    <p className="key-meta">
                      Created: {new Date(key.created_at).toLocaleDateString()}
                      {key.last_used_at && ` • Last used: ${new Date(key.last_used_at).toLocaleDateString()}`}
                    </p>
                  </div>
                  <button onClick={() => handleDeleteApiKey(key.id)} className="danger">
                    Revoke
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {activeTab === 'account' && (
        <div className="television-account">
          <h3>Subscription</h3>
          {user?.subscription_status === 'active' ? (
            <div className="subscription-active">
              <p className="status-badge active">Active</p>
              <p>Plan: {user.subscription_period}</p>
              {user.subscription_expires_at && (
                <p>Expires: {new Date(user.subscription_expires_at).toLocaleDateString()}</p>
              )}
            </div>
          ) : (
            <div className="subscription-inactive">
              <p>No active subscription.</p>
              <button className="primary-btn" disabled>
                Subscribe (Coming Soon)
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default TelevisionTab;
