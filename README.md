# 🔄 Web File Converter

A professional web-based file conversion platform with multiple specialized tools for image and video format conversion. Built with modern web technologies and featuring a clean, responsive design with dark/light theme support.

## 🌟 Features

### **Image Converters**
- **📸 PNG → JPEG Converter** - High-quality PNG to JPEG conversion with adjustable quality settings
- **🖼️ Image → 100×100 PNG** - Perfect for creating custom icons, emojis, and profile pictures
- **🏷️ Image → 512×512 PNG** - Optimized for Telegram stickers and animated emojis

### **Video/Animation Converters**
- **🎬 GIF → WebM Converter + Editor** - Professional GIF to WebM conversion with built-in timeline editor
  - Timeline trimming and loop controls
  - Size optimization for web use
  - Perfect for animated stickers and Discord emojis

### **Core Features**
- 🌙 **Dark/Light Theme** - Automatic system preference detection with manual toggle
- 📱 **Responsive Design** - Works seamlessly on desktop, tablet, and mobile
- 🎨 **Modern UI** - Clean card-based interface with intuitive navigation
- ⚡ **Client-Side Processing** - Fast, secure local file processing
- 🔒 **Privacy-First** - Files never leave your device (except for GIF→WebM server processing)

## 🚀 Live Demo

Visit the live application: [https://converter.piogino.ch](https://converter.piogino.ch)

## 📁 Project Structure

```
file-converter/
├── assets/
│   ├── scripts/
│   │   ├── core/                 # Shared utilities
│   │   ├── converters/           # Converter-specific scripts
│   │   └── gif-editor/           # GIF editor modules
│   │       ├── controllers/      # Input & video controllers
│   │       ├── ui/              # UI management
│   │       └── utils/           # Helper utilities
│   └── styles/
│       ├── core/                # Base styles & variables
│       ├── components/          # Reusable components
│       ├── pages/              # Page-specific styles
│       └── themes/             # Theme switching
├── pages/
│   ├── index.html              # Main landing page
│   └── converters/             # Individual converter pages
├── server/                     # Python backend (FFmpeg)
└── uploads/                    # Temporary file storage
```

## 🛠️ Technologies Used

### **Frontend**
- **HTML5** - Semantic markup with modern features
- **CSS3** - Advanced styling with CSS Grid, Flexbox, and Custom Properties
- **Vanilla JavaScript** - Modular ES6+ code with no external dependencies
- **Canvas API** - Client-side image processing and manipulation
- **File API** - Drag & drop file handling

### **Backend** (GIF Converter)
- **Python** - Server-side processing
- **FFmpeg** - Professional video/animation conversion
- **VP9 Codec** - High-quality WebM output

## 🎯 Use Cases

### **Content Creators**
- Convert GIFs to WebM for better compression and quality
- Create custom animated stickers for Telegram
- Generate Discord animated emojis
- Optimize images for web publishing

### **Developers**
- Batch convert PNG files to JPEG for web optimization
- Create consistent icon sets (100×100 PNG)
- Prepare assets for mobile apps

### **General Users**
- Reduce file sizes for email attachments
- Convert images for social media platforms
- Create custom profile pictures and avatars

## 🚀 Quick Start

### **Option 1: Use Online (Recommended)**
Simply visit [https://converter.piogino.ch](https://converter.piogino.ch) and start converting!

### **Option 2: Local Development**

1. **Clone the repository**
   ```bash
   git clone https://github.com/piosteiner/file-converter.git
   cd file-converter
   ```

2. **Serve locally**
   ```bash
   # Using Python
   python -m http.server 8000
   
   # Using Node.js
   npx serve .
   
   # Using PHP
   php -S localhost:8000
   ```

3. **Access the application**
   Open [http://localhost:8000](http://localhost:8000) in your browser

### **Option 3: GIF Converter Backend Setup**

For the GIF→WebM converter with server-side processing:

1. **Install Python dependencies**
   ```bash
   pip install -r requirements.txt
   ```

2. **Install FFmpeg**
   - **Windows**: Download from [ffmpeg.org](https://ffmpeg.org/download.html)
   - **macOS**: `brew install ffmpeg`
   - **Linux**: `sudo apt install ffmpeg`

3. **Run the Python server**
   ```bash
   python server/server.py
   ```

## 📱 Browser Support

- **Chrome/Edge** 88+ (Recommended)
- **Firefox** 85+
- **Safari** 14+
- **Mobile browsers** with File API support

## 🎨 Design Principles

### **User Experience**
- **Intuitive Interface** - Clear visual hierarchy and familiar interaction patterns
- **Instant Feedback** - Real-time progress indicators and status updates
- **Error Handling** - Graceful degradation with helpful error messages

### **Performance**
- **Optimized Assets** - Minified CSS/JS and efficient loading strategies
- **Client-Side Processing** - Reduces server load and improves privacy
- **Progressive Enhancement** - Core functionality works without JavaScript

### **Accessibility**
- **Keyboard Navigation** - Full keyboard support for all interactions
- **Screen Reader Friendly** - Semantic HTML with proper ARIA labels
- **High Contrast** - WCAG-compliant color schemes in both themes

## 🔧 Configuration

### **Theme Customization**
Modify `assets/styles/core/variables.css` to customize colors and spacing:

```css
:root {
  --primary-color: #007acc;
  --background-color: #ffffff;
  --text-color: #333333;
  /* ... other variables */
}
```

### **Adding New Converters**
1. Create HTML file in `pages/converters/`
2. Add converter script in `assets/scripts/converters/`
3. Update navigation in all pages
4. Add page-specific styles if needed

## 🤝 Contributing

We welcome contributions! Please follow these steps:

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/amazing-feature`
3. **Commit your changes**: `git commit -m 'Add amazing feature'`
4. **Push to the branch**: `git push origin feature/amazing-feature`
5. **Open a Pull Request**

### **Development Guidelines**
- Follow the existing code style and structure
- Test all converters thoroughly
- Ensure responsive design works on all devices
- Update documentation for new features

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **FFmpeg** - Powerful multimedia processing
- **Modern Web APIs** - File, Canvas, and Drag & Drop APIs
- **Open Source Community** - For inspiration and best practices

## 📞 Support

If you encounter any issues or have questions:

1. **Check existing issues** on GitHub
2. **Create a new issue** with detailed description
3. **Contact**: [Your contact information]

---

**Made with ❤️ for the web development community**

*Convert files easily, privately, and professionally - right in your browser!*
