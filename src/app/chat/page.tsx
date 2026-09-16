'use client';

import { useEffect, useState, useRef, UIEvent } from 'react';
import { useRouter } from 'next/navigation';
import { io, Socket } from 'socket.io-client';

import { API_BASE_URL } from '../../../config';

// Configuration with STUN and TURN Relays for strict NAT/firewall traversal
const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
};

interface RemotePeer {
  stream: MediaStream;
  userName: string;
}

export default function ChatPage() {
  const [user, setUser] = useState<any>(null);
  const [rooms, setRooms] = useState<any[]>([]);
  const [currentRoom, setCurrentRoom] = useState<any>(null);
  const [roomMembers, setRoomMembers] = useState<any[]>([]);
  const [messages, setMessages] = useState<any[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [newRoomName, setNewRoomName] = useState('');
  const [socket, setSocket] = useState<Socket | null>(null);

  // Pagination State
  const [hasMoreMessages, setHasMoreMessages] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const chatContainerRef = useRef<HTMLDivElement | null>(null);

  // Message Editing State
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');

  // Mobile Viewport Drawer States
  const [showMobileRooms, setShowMobileRooms] = useState(true);
  const [showMobileMembers, setShowMobileMembers] = useState(false);

  // WebRTC Multi-User State
  const [isInCall, setIsInCall] = useState(false);
  const [showMediaModal, setShowMediaModal] = useState(false); // Modal for camera preference choice
  const [remoteStreams, setRemoteStreams] = useState<Record<string, RemotePeer>>({});
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  // Dedicated Map to hold reference to remote video DOM nodes for reliable playback binding
  const remoteVideoRefs = useRef<{ [key: string]: HTMLVideoElement | null }>({});

  // WebRTC Peer References
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  
  // Bulletproof Global ICE Queue: stores incoming candidates per senderSocketId even if PC isn't created yet!
  const incomingIceCandidatesBufferRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());

  // Media Controls State
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);

  // File Upload State
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const router = useRouter();

  // Helper function to cleanly remove a specific peer's connection and stream
  const removePeer = (targetSocketId: string) => {
    console.log(`[WebRTC] Removing peer and cleaning up resources for: ${targetSocketId}`);
    
    const pc = peerConnectionsRef.current.get(targetSocketId);
    if (pc) {
      pc.close();
      peerConnectionsRef.current.delete(targetSocketId);
    }

    incomingIceCandidatesBufferRef.current.delete(targetSocketId);
    delete remoteVideoRefs.current[targetSocketId];

    setRemoteStreams((prev) => {
      const updated = { ...prev };
      delete updated[targetSocketId];
      return updated;
    });
  };

  // Helper to flush queued candidates safely into an active peer connection
  const flushQueuedIceCandidates = async (targetSocketId: string, pc: RTCPeerConnection) => {
    if (!pc.remoteDescription || !pc.remoteDescription.type) {
      return;
    }
    const queue = incomingIceCandidatesBufferRef.current.get(targetSocketId);
    if (queue && queue.length > 0) {
      while (queue.length > 0) {
        const candidate = queue.shift();
        if (candidate) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (e) {
            console.error('[WebRTC] Error adding buffered ICE candidate:', e);
          }
        }
      }
    }
  };

  // Acquire local stream based on user's choice (video + audio vs audio-only)
  const initializeLocalStream = async (withVideo: boolean): Promise<MediaStream> => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
    }

    try {
      const constraints: MediaStreamConstraints = {
        video: withVideo ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
        audio: true,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      localStreamRef.current = stream;
      setIsInCall(true);
      setIsVideoOff(!withVideo);
      setShowMediaModal(false);
      return stream;
    } catch (err) {
      console.warn('[WebRTC] Failed with requested settings, falling back to audio-only...', err);
      const audioStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      localStreamRef.current = audioStream;
      setIsInCall(true);
      setIsVideoOff(true);
      setShowMediaModal(false);
      return audioStream;
    }
  };

  // Helper function to create peer connections with polite/impolite collision handling & consistent ordering
  const createPeerConnection = (
    targetSocketId: string,
    targetUserName: string,
    activeSocket: Socket,
    currentUser: any,
    roomId: string
  ) => {
    if (peerConnectionsRef.current.has(targetSocketId)) {
      return peerConnectionsRef.current.get(targetSocketId)!;
    }

    const pc = new RTCPeerConnection(ICE_SERVERS);
    peerConnectionsRef.current.set(targetSocketId, pc);

    // 1. Capture incoming remote tracks safely
    pc.ontrack = (event) => {
      console.log(`[WebRTC] ontrack fired from ${targetSocketId}`, event);
      event.track.enabled = true;

      setRemoteStreams((prev) => {
        let existing = prev[targetSocketId];
        let stream = existing ? existing.stream : new MediaStream();

        if (!stream.getTracks().some((t) => t.id === event.track.id)) {
          stream.addTrack(event.track);
        }

        return {
          ...prev,
          [targetSocketId]: { stream, userName: targetUserName },
        };
      });
    };

    pc.onconnectionstatechange = () => {
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        removePeer(targetSocketId);
      }
    };

    // 2. Attach local tracks uniformly
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        const senders = pc.getSenders();
        const exists = senders.some((s) => s.track === track);
        if (!exists) {
          pc.addTrack(track, localStreamRef.current!);
        }
      });
    }

    // 3. ICE candidate handling
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        activeSocket.emit('webrtc_ice_candidate', {
          roomId,
          targetSocketId,
          candidate: event.candidate,
          senderSocketId: activeSocket.id,
          senderId: currentUser.id,
        });
      }
    };

    // 4. Polite/Impolite check to prevent race conditions & SDP m-line order crashes
    const isPolite = activeSocket.id < targetSocketId;
    let makingOffer = false;
    let ignoreOffer = false;

    pc.onnegotiationneeded = async () => {
      try {
        makingOffer = true;
        await pc.setLocalDescription();
        activeSocket.emit('webrtc_offer', {
          roomId,
          targetSocketId,
          offer: pc.localDescription,
          senderSocketId: activeSocket.id,
          senderId: currentUser.id,
          senderName: currentUser.name,
        });
      } catch (err) {
        console.error('[WebRTC] Negotiation failed:', err);
      } finally {
        makingOffer = false;
      }
    };

    // Attach custom handleOffer method to manage glare gracefully
    (pc as any).handleOffer = async (offer: any) => {
      const offerCollision = makingOffer || pc.signalingState !== 'stable';
      ignoreOffer = !isPolite && offerCollision;

      if (ignoreOffer) return;

      if (offerCollision) {
        await pc.setLocalDescription({ type: 'rollback' });
      }

      await pc.setRemoteDescription(new RTCSessionDescription(offer));

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          const senders = pc.getSenders();
          const exists = senders.some((s) => s.track === track);
          if (!exists) {
            pc.addTrack(track, localStreamRef.current!);
          }
        });
      }

      await flushQueuedIceCandidates(targetSocketId, pc);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      activeSocket.emit('webrtc_answer', {
        roomId,
        targetSocketId,
        answer: pc.localDescription,
        senderSocketId: activeSocket.id,
        senderId: currentUser.id,
        senderName: currentUser.name,
      });
    };

    flushQueuedIceCandidates(targetSocketId, pc);
    return pc;
  };

  useEffect(() => {
    const token = localStorage.getItem('token');
    const storedUser = localStorage.getItem('user');

    if (!token || !storedUser) {
      router.push('/');
      return;
    }

    const parsedUser = JSON.parse(storedUser);
    setUser(parsedUser);

    const newSocket = io(API_BASE_URL, { auth: { token } });
    setSocket(newSocket);

    fetchRooms();

    newSocket.on('receive_message', (message: any) => {
      setMessages((prev) => [...prev, message]);
      scrollToBottom();
    });

    newSocket.on('message_edited', (updatedMessage: any) => {
      setMessages((prev) =>
        prev.map((msg) => (msg.id === updatedMessage.id ? { ...msg, ...updatedMessage } : msg))
      );
    });

    newSocket.on('message_deleted', ({ messageId }: { messageId: string }) => {
      setMessages((prev) => prev.filter((msg) => msg.id !== messageId));
    });

    newSocket.on('room_users', (users: any[]) => {
      setRoomMembers(users);

      const activeSocketIds = new Set(users.map((u) => u.socketId));
      peerConnectionsRef.current.forEach((_, socketId) => {
        if (!activeSocketIds.has(socketId)) {
          removePeer(socketId);
        }
      });
    });

    // --- WEBRTC SIGNALING HANDLERS ---

    newSocket.on('user_started_call', async ({ callerSocketId, callerUserName, roomId, callerId }) => {
      if (callerSocketId !== newSocket.id && callerId !== parsedUser.id) {
        try {
          if (!localStreamRef.current) {
            // Default to audio-only if incoming call and no local stream established yet, or user can toggle cam later
            const audioStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
            localStreamRef.current = audioStream;
            setIsInCall(true);
            setIsVideoOff(true);
          }
          createPeerConnection(callerSocketId, callerUserName || 'Peer', newSocket, parsedUser, roomId);
        } catch (err) {
          console.error('[WebRTC] Error handling user_started_call:', err);
        }
      }
    });

    newSocket.on('user_ended_call', ({ socketId }: { socketId: string }) => {
      removePeer(socketId);
    });

    newSocket.on('webrtc_offer', async ({ offer, senderSocketId, senderName, roomId, senderId }) => {
      if (senderId === parsedUser.id || senderSocketId === newSocket.id) return;

      try {
        const pc = createPeerConnection(senderSocketId, senderName || 'Peer', newSocket, parsedUser, roomId);
        await (pc as any).handleOffer(offer);
      } catch (err) {
        console.error('[WebRTC] Error handling WebRTC offer:', err);
      }
    });

    newSocket.on('webrtc_answer', async ({ answer, senderSocketId, senderId }) => {
      if (senderId === parsedUser.id || senderSocketId === newSocket.id) return;

      const pc = peerConnectionsRef.current.get(senderSocketId);
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        await flushQueuedIceCandidates(senderSocketId, pc);
      }
    });

    newSocket.on('webrtc_ice_candidate', async ({ candidate, senderSocketId, senderId }) => {
      if (senderId === parsedUser.id || senderSocketId === newSocket.id) return;

      const pc = peerConnectionsRef.current.get(senderSocketId);

      if (pc && pc.remoteDescription && pc.remoteDescription.type) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.error('[WebRTC] Error adding incoming ICE candidate directly:', e);
        }
      } else {
        const existingQueue = incomingIceCandidatesBufferRef.current.get(senderSocketId) || [];
        existingQueue.push(candidate);
        incomingIceCandidatesBufferRef.current.set(senderSocketId, existingQueue);
      }
    });

    return () => {
      newSocket.disconnect();
    };
  }, []);

  useEffect(() => {
    if (isInCall && localStreamRef.current && localVideoRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
    }
  }, [isInCall, isVideoOff]);

  useEffect(() => {
    Object.entries(remoteStreams).forEach(([socketId, { stream }]) => {
      const videoEl = remoteVideoRefs.current[socketId];
      if (videoEl) {
        if (videoEl.srcObject !== stream) {
          videoEl.srcObject = stream;
        }
        
        stream.getTracks().forEach((track) => {
          track.enabled = true;
        });

        videoEl.play().catch((err) => {
          console.warn('[WebRTC] Autoplay error, retrying muted:', err);
          videoEl.muted = true;
          videoEl.play().catch((e) => console.error('[WebRTC] Fatal playback error:', e));
        });
      }
    });
  }, [remoteStreams]);

  const scrollToBottom = () => {
    setTimeout(() => {
      if (chatContainerRef.current) {
        chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
      }
    }, 50);
  };

  const fetchRooms = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_BASE_URL}/api/chat/rooms`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setRooms(data);
      }
    } catch (err) {
      console.error('Failed to fetch rooms', err);
    }
  };

  const createRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRoomName.trim()) return;

    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_BASE_URL}/api/chat/rooms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: newRoomName, userId: user?.id }),
      });

      if (res.ok) {
        setNewRoomName('');
        fetchRooms();
      }
    } catch (err) {
      console.error('Error creating room', err);
    }
  };

  const fetchRoomMessages = async (roomId: string) => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_BASE_URL}/api/chat/rooms/${roomId}/messages?limit=20`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.ok) {
        const data = await res.json();
        const formatted = data.map((msg: any) => ({
          ...msg,
          userName: msg.userName || msg.user?.name || 'User',
        }));

        setMessages(formatted);
        setHasMoreMessages(data.length >= 20);
        scrollToBottom();
      }
    } catch (err) {
      console.error('Failed to fetch messages', err);
    }
  };

  const loadMoreMessages = async () => {
    if (!currentRoom || isLoadingMore || !hasMoreMessages || messages.length === 0) return;

    setIsLoadingMore(true);
    const firstMessageId = messages[0]?.id;
    const scrollContainer = chatContainerRef.current;
    const previousScrollHeight = scrollContainer ? scrollContainer.scrollHeight : 0;

    try {
      const token = localStorage.getItem('token');
      const res = await fetch(
        `${API_BASE_URL}/api/chat/rooms/${currentRoom.id}/messages?cursor=${firstMessageId}&limit=20`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (res.ok) {
        const olderMessages = await res.json();
        if (olderMessages.length < 20) {
          setHasMoreMessages(false);
        }

        const formatted = olderMessages.map((msg: any) => ({
          ...msg,
          userName: msg.userName || msg.user?.name || 'User',
        }));

        setMessages((prev) => [...formatted, ...prev]);

        setTimeout(() => {
          if (scrollContainer) {
            scrollContainer.scrollTop = scrollContainer.scrollHeight - previousScrollHeight;
          }
        }, 0);
      }
    } catch (err) {
      console.error('Failed to load older messages', err);
    } finally {
      setIsLoadingMore(false);
    }
  };

  const handleScroll = (e: UIEvent<HTMLDivElement>) => {
    if (e.currentTarget.scrollTop === 0 && hasMoreMessages && !isLoadingMore) {
      loadMoreMessages();
    }
  };

  const joinRoom = async (room: any) => {
    if (isInCall) {
      endCall();
    }

    setCurrentRoom(room);
    setMessages([]);
    setHasMoreMessages(true);
    setShowMobileRooms(false);
    setShowMobileMembers(false);
    fetchRoomMessages(room.id);

    socket?.emit('join_room', {
      roomId: room.id,
      userId: user?.id,
      userName: user?.name,
    });
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setSelectedFile(e.target.files[0]);
    }
  };

  const sendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if ((!newMessage.trim() && !selectedFile) || !currentRoom) return;

    if (selectedFile) {
      const reader = new FileReader();
      reader.onload = () => {
        socket?.emit('send_message', {
          roomId: currentRoom.id,
          content: newMessage || `Sent file: ${selectedFile.name}`,
          file: {
            name: selectedFile.name,
            type: selectedFile.type,
            base64: reader.result as string,
          },
          userId: user.id,
          userName: user.name,
        });

        setSelectedFile(null);
        setNewMessage('');
        if (fileInputRef.current) fileInputRef.current.value = '';
      };
      reader.readAsDataURL(selectedFile);
    } else {
      socket?.emit('send_message', {
        roomId: currentRoom.id,
        content: newMessage,
        userId: user.id,
        userName: user.name,
      });

      setNewMessage('');
    }
  };

  const handleSaveEdit = async (messageId: string) => {
    if (!editingContent.trim() || !currentRoom?.id) return;

    try {
      const token = localStorage.getItem('token');
      const currentUserId = user?.id || localStorage.getItem('userId');

      const res = await fetch(`${API_BASE_URL}/api/chat/messages/${messageId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          content: editingContent,
          userId: currentUserId,
        }),
      });

      if (res.ok) {
        const updatedMsg = await res.json();

        setMessages((prevMessages) =>
          prevMessages.map((msg) => (msg.id === messageId ? updatedMsg : msg))
        );

        socket?.emit('edit_message', {
          roomId: currentRoom.id,
          message: updatedMsg,
        });

        setEditingMessageId(null);
        setEditingContent('');
      }
    } catch (err) {
      console.error('Failed to edit message:', err);
    }
  };

  const handleDeleteMessage = async (messageId: string) => {
    if (!currentRoom?.id) return;
    if (!confirm('Are you sure you want to delete this message?')) return;

    try {
      const token = localStorage.getItem('token');
      const currentUserId = user?.id || localStorage.getItem('userId');

      const res = await fetch(`${API_BASE_URL}/api/chat/messages/${messageId}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ userId: currentUserId }),
      });

      if (res.ok) {
        setMessages((prevMessages) => prevMessages.filter((msg) => msg.id !== messageId));

        socket?.emit('delete_message', {
          roomId: currentRoom.id,
          messageId,
        });
      }
    } catch (err) {
      console.error('Failed to delete message:', err);
    }
  };

  const toggleAudio = () => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMuted(!audioTrack.enabled);
      }
    }
  };

  const toggleVideo = () => {
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsVideoOff(!videoTrack.enabled);
      }
    }
  };

  const startCall = async (withVideo: boolean) => {
    if (!socket || !currentRoom) return;

    try {
      const stream = await initializeLocalStream(withVideo);

      socket.emit('start_call', {
        roomId: currentRoom.id,
        userId: user?.id,
        userName: user?.name,
        socketId: socket.id,
      });

      roomMembers.forEach((member) => {
        if (member.userId !== user?.id && member.socketId && member.socketId !== socket.id) {
          const pc = createPeerConnection(member.socketId, member.userName, socket, user, currentRoom.id);
          stream.getTracks().forEach((track) => {
            const senders = pc.getSenders();
            const exists = senders.some((s) => s.track === track);
            if (!exists) {
              pc.addTrack(track, stream);
            }
          });
        }
      });
    } catch (err) {
      console.error('[WebRTC] Failed to start call:', err);
    }
  };

  const endCall = () => {
    if (socket && currentRoom) {
      socket.emit('end_call', { roomId: currentRoom.id, socketId: socket.id });
    }

    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;

    peerConnectionsRef.current.forEach((pc) => pc.close());
    peerConnectionsRef.current.clear();
    incomingIceCandidatesBufferRef.current.clear();
    remoteVideoRefs.current = {};

    setRemoteStreams({});
    setIsInCall(false);
    setIsMuted(false);
    setIsVideoOff(false);
    setShowMediaModal(false);
  };

  return (
    <div className="flex h-screen w-full bg-slate-950 text-slate-100 overflow-hidden font-sans">
      {/* Sidebar - Rooms */}
      <div
        className={`${
          showMobileRooms ? 'flex' : 'hidden'
        } md:flex flex-col w-full md:w-1/4 h-full bg-slate-900 border-r border-slate-800 p-4 z-20 shrink-0`}
      >
        <div className="flex justify-between items-center mb-6 pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-amber-500 animate-pulse"></span>
            <div>
              <h1 className="text-base font-extrabold tracking-wider text-amber-400 uppercase">
                PLUS UAE
              </h1>
              <p className="text-[10px] text-slate-400 tracking-widest uppercase">
                Enterprise Workspace
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              localStorage.clear();
              router.push('/');
            }}
            className="text-xs bg-red-600/20 text-red-400 border border-red-500/30 px-3 py-1.5 rounded hover:bg-red-600 hover:text-white transition"
          >
            Logout
          </button>
        </div>

        <div className="mb-4">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">
            Chat Rooms
          </h2>
          <form onSubmit={createRoom} className="flex gap-2">
            <input
              type="text"
              placeholder="New channel name..."
              value={newRoomName}
              onChange={(e) => setNewRoomName(e.target.value)}
              className="w-full p-2.5 text-sm bg-slate-800 border border-slate-700 rounded-lg focus:outline-none focus:border-amber-500/50 transition text-slate-200 placeholder-slate-500"
            />
            <button
              type="submit"
              className="bg-amber-500 text-slate-950 px-4 py-2.5 text-sm rounded-lg font-bold hover:bg-amber-400 transition"
            >
              +
            </button>
          </form>
        </div>

        <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
          {rooms.map((room) => (
            <div
              key={room.id}
              onClick={() => joinRoom(room)}
              className={`p-3 rounded-lg cursor-pointer transition flex items-center justify-between ${
                currentRoom?.id === room.id
                  ? 'bg-amber-500/10 border border-amber-500/30 text-amber-400 font-semibold'
                  : 'bg-slate-800/60 border border-transparent hover:bg-slate-800 text-slate-300'
              }`}
            >
              <p className="truncate text-sm"># {room.name}</p>
              {currentRoom?.id === room.id && (
                <span className="w-2 h-2 rounded-full bg-amber-400"></span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Main Area */}
      <div
        className={`${
          !showMobileRooms ? 'flex' : 'hidden'
        } md:flex flex-1 h-full w-full bg-slate-950 overflow-hidden relative`}
      >
        {currentRoom ? (
          <div className="flex flex-1 h-full w-full overflow-hidden">
            <div className="flex-1 flex flex-col h-full overflow-hidden border-r border-slate-800">
              {/* Header */}
              <div className="p-3 md:p-4 bg-slate-900 border-b border-slate-800 flex justify-between items-center gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <button
                    onClick={() => setShowMobileRooms(true)}
                    className="md:hidden bg-slate-800 border border-slate-700 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-slate-300"
                  >
                    ← Channels
                  </button>
                  <h3 className="text-base md:text-lg font-bold text-slate-100 truncate">
                    # {currentRoom.name}
                  </h3>
                </div>

                <div className="flex gap-2 items-center shrink-0">
                  <button
                    onClick={() => setShowMobileMembers(!showMobileMembers)}
                    className="lg:hidden bg-slate-800 border border-slate-700 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-slate-300"
                  >
                    👥 ({roomMembers.length})
                  </button>

                  {isInCall && (
                    <>
                      <button
                        onClick={toggleAudio}
                        className={`px-3 py-1.5 md:py-2 rounded-lg text-xs font-semibold transition ${
                          isMuted
                            ? 'bg-red-600 text-white'
                            : 'bg-slate-800 border border-slate-700 text-slate-200'
                        }`}
                      >
                        {isMuted ? 'Unmute' : 'Mute'}
                      </button>
                      <button
                        onClick={toggleVideo}
                        className={`px-3 py-1.5 md:py-2 rounded-lg text-xs font-semibold transition ${
                          isVideoOff
                            ? 'bg-red-600 text-white'
                            : 'bg-slate-800 border border-slate-700 text-slate-200'
                        }`}
                      >
                        {isVideoOff ? 'Cam Off' : 'Cam On'}
                      </button>
                    </>
                  )}

                  {!isInCall ? (
                    <button
                      onClick={() => setShowMediaModal(true)}
                      className="bg-emerald-600 hover:bg-emerald-500 text-white px-3.5 py-1.5 md:py-2 rounded-lg text-xs md:text-sm font-semibold transition shadow-lg shadow-emerald-950/50"
                    >
                      Start Call
                    </button>
                  ) : (
                    <button
                      onClick={endCall}
                      className="bg-red-600 hover:bg-red-500 text-white px-3.5 py-1.5 md:py-2 rounded-lg text-xs md:text-sm font-semibold transition shadow-lg shadow-red-950/50"
                    >
                      End Call
                    </button>
                  )}
                </div>
              </div>

              {/* Media Choice Modal */}
              {showMediaModal && (
                <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                  <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-sm w-full shadow-2xl text-center space-y-4">
                    <h3 className="text-lg font-bold text-amber-400">Choose Call Mode</h3>
                    <p className="text-xs text-slate-400">
                      Would you like to share your webcam or join with audio only (mic only)? You will still be able to see other participants.
                    </p>
                    <div className="flex flex-col gap-2 pt-2">
                      <button
                        onClick={() => startCall(true)}
                        className="w-full bg-emerald-600 hover:bg-emerald-500 text-white py-2.5 rounded-lg text-sm font-semibold transition"
                      >
                        📹 Share Camera & Mic
                      </button>
                      <button
                        onClick={() => startCall(false)}
                        className="w-full bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 py-2.5 rounded-lg text-sm font-semibold transition"
                      >
                        🎙️ Audio Only (Mic Only)
                      </button>
                      <button
                        onClick={() => setShowMediaModal(false)}
                        className="w-full text-xs text-slate-500 hover:text-slate-300 py-1.5 mt-1"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Video Grid */}
              {(isInCall || Object.keys(remoteStreams).length > 0) && (
                <div className="p-3 bg-black border-b border-slate-800 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 max-h-96 overflow-y-auto shrink-0">
                  {isInCall && (
                    <div className="relative bg-slate-900 rounded-lg overflow-hidden border border-slate-800 aspect-video flex items-center justify-center">
                      <video
                        ref={localVideoRef}
                        autoPlay
                        playsInline
                        muted
                        className={`w-full h-full object-cover ${isVideoOff ? 'hidden' : ''}`}
                      />
                      {isVideoOff && (
                        <div className="absolute inset-flex items-center justify-center text-xs text-slate-400 font-semibold bg-slate-900">
                          Camera Off / Audio Only
                        </div>
                      )}
                      <span className="absolute bottom-2 left-2 bg-slate-950/80 text-amber-400 border border-amber-500/30 px-2 py-0.5 text-[10px] font-semibold rounded z-20">
                        You {isVideoOff ? '(Audio Only)' : ''}
                      </span>
                    </div>
                  )}

                  {Object.entries(remoteStreams).map(([socketId, { stream, userName }]) => (
                    <div
                      key={socketId}
                      className="relative bg-slate-900 rounded-lg overflow-hidden border border-slate-800 aspect-video flex items-center justify-center"
                    >
                      <video
                        ref={(el) => {
                          remoteVideoRefs.current[socketId] = el;
                          if (el && el.srcObject !== stream) {
                            el.srcObject = stream;
                          }
                        }}
                        autoPlay
                        playsInline
                        className="w-full h-full object-cover"
                      />

                      <span className="absolute bottom-2 left-2 bg-slate-950/80 text-slate-200 border border-slate-700 px-2 py-0.5 text-[10px] font-semibold rounded truncate max-w-[80%] z-20">
                        {userName}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Chat Messages */}
              <div
                ref={chatContainerRef}
                onScroll={handleScroll}
                className="flex-1 p-3 md:p-4 overflow-y-auto space-y-3"
              >
                {isLoadingMore && (
                  <div className="text-center text-xs text-amber-400 py-2 font-medium">
                    Loading older messages...
                  </div>
                )}

                {messages.map((msg, index) => {
                  const isMe = msg.userId === user?.id;
                  const isEditing = editingMessageId === msg.id;

                  return (
                    <div
                      key={msg.id || index}
                      className={`flex flex-col group ${isMe ? 'items-end' : 'items-start'}`}
                    >
                      <span className="text-[11px] text-slate-400 mb-1 px-1">
                        {msg.userName || 'User'}
                        {msg.isEdited && (
                          <span className="ml-1 text-[9px] text-slate-500">(edited)</span>
                        )}
                      </span>

                      <div
                        className={`relative p-3 rounded-xl max-w-[85%] md:max-w-md break-words text-sm shadow-sm ${
                          isMe
                            ? 'bg-amber-500 text-slate-950 font-medium rounded-tr-none'
                            : 'bg-slate-900 border border-slate-800 text-slate-200 rounded-tl-none'
                        }`}
                      >
                        {isEditing ? (
                          <div className="flex flex-col gap-2 min-w-[200px]">
                            <input
                              type="text"
                              value={editingContent}
                              onChange={(e) => setEditingContent(e.target.value)}
                              className="p-1.5 text-xs bg-slate-950 text-slate-100 border border-slate-700 rounded focus:outline-none"
                            />
                            <div className="flex gap-2 justify-end">
                              <button
                                onClick={() => handleSaveEdit(msg.id)}
                                className="text-[10px] bg-slate-950 text-amber-400 px-2 py-1 rounded border border-amber-500/30"
                              >
                                Save
                              </button>
                              <button
                                onClick={() => setEditingMessageId(null)}
                                className="text-[10px] bg-slate-800 text-slate-300 px-2 py-1 rounded"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            {msg.content}
                            {msg.file?.base64 && (
                              <div className="mt-2">
                                {msg.file.type?.startsWith('image/') ? (
                                  <img
                                    src={msg.file.base64}
                                    alt={msg.file.name}
                                    className="max-w-xs rounded-lg border border-black/10"
                                  />
                                ) : (
                                  <a
                                    href={msg.file.base64}
                                    download={msg.file.name}
                                    className={`underline text-xs block truncate ${
                                      isMe ? 'text-slate-900 font-semibold' : 'text-amber-400'
                                    }`}
                                  >
                                    📎 Download {msg.file.name}
                                  </a>
                                )}
                              </div>
                            )}

                            {isMe && !isEditing && (
                              <div className="absolute -top-3 right-1 hidden group-hover:flex items-center bg-slate-900 border border-slate-800 rounded px-1 py-0.5 gap-1 shadow-md">
                                <button
                                  onClick={() => {
                                    setEditingMessageId(msg.id);
                                    setEditingContent(msg.content);
                                  }}
                                  className="text-[10px] text-amber-400 hover:text-amber-300 px-1"
                                >
                                  ✏️
                                </button>
                                <button
                                  onClick={() => handleDeleteMessage(msg.id)}
                                  className="text-[10px] text-red-400 hover:text-red-300 px-1"
                                >
                                  🗑️
                                </button>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Input Bar */}
              <form
                onSubmit={sendMessage}
                className="p-3 md:p-4 bg-slate-900 border-t border-slate-800 flex gap-2 items-center shrink-0"
              >
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileUpload}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 px-3 py-2.5 md:py-3 rounded-lg text-sm shrink-0 transition"
                >
                  📎
                </button>

                {selectedFile && (
                  <span className="text-xs bg-slate-800 border border-slate-700 text-amber-400 px-2 py-1 rounded max-w-[90px] sm:max-w-[120px] truncate shrink-0">
                    {selectedFile.name}
                  </span>
                )}

                <input
                  type="text"
                  placeholder="Type a message..."
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  className="flex-1 min-w-0 p-2.5 md:p-3 text-sm bg-slate-800 border border-slate-700 rounded-lg focus:outline-none focus:border-amber-500/50 text-slate-100 placeholder-slate-500"
                />
                <button
                  type="submit"
                  className="bg-amber-500 text-slate-950 px-5 md:px-6 py-2.5 md:py-3 rounded-lg text-sm font-bold hover:bg-amber-400 transition shrink-0"
                >
                  Send
                </button>
              </form>
            </div>

            {/* Members List */}
            <div
              className={`${
                showMobileMembers ? 'fixed inset-y-0 right-0 z-30 w-64' : 'hidden'
              } lg:flex lg:relative lg:w-64 bg-slate-900 p-4 flex-col border-l border-slate-800 shrink-0`}
            >
              <div className="flex justify-between items-center mb-4 pb-2 border-b border-slate-800">
                <h4 className="text-xs font-bold text-amber-400 uppercase tracking-wider">
                  Active Members ({roomMembers.length})
                </h4>
                <button
                  onClick={() => setShowMobileMembers(false)}
                  className="lg:hidden text-xs text-slate-400 hover:text-white"
                >
                  ✕
                </button>
              </div>

              <div className="space-y-2 overflow-y-auto flex-1 pr-1">
                {roomMembers.map((member, idx) => (
                  <div
                    key={idx}
                    className="flex items-center gap-2.5 text-sm p-2.5 bg-slate-800/50 border border-slate-800 rounded-lg"
                  >
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0"></span>
                    <span className="truncate text-slate-300">{member.userName}</span>
                    {member.userId === user?.id && (
                      <span className="text-[10px] text-amber-400 ml-auto shrink-0">(You)</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-4 text-center text-slate-500">
            <button
              onClick={() => setShowMobileRooms(true)}
              className="md:hidden mb-4 bg-amber-500 text-slate-950 px-4 py-2 rounded-lg text-sm font-bold"
            >
              Open Channels
            </button>
            <span>Select or create a chat room to start messaging</span>
          </div>
        )}
      </div>
    </div>
  );
}
