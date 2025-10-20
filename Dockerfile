# Step 1: Use an official Node.js runtime as the base image
# Using Node.js 18, which is a stable LTS (Long-Term Support) version
FROM node:18

# Step 2: Set the working directory inside the container
WORKDIR /app

# Step 3: Copy package.json and package-lock.json first
# This leverages Docker's layer caching. The 'npm install' step will only be re-run
# if the dependencies in package.json have changed.
COPY package*.json ./

# Step 4: Install the application dependencies
# --production flag ensures we don't install development dependencies, keeping the image small
RUN npm install --production

# Step 5: Copy the rest of your application files into the container
# This includes server.js, index.html, and any other assets like fonts or logos.
COPY . .

# Step 6: Expose the port the app will run on
# Hugging Face Spaces typically use port 7860 by default. Our server.js will read this from process.env.PORT.
EXPOSE 7860

# Step 7: Define the command to run your application
# This will execute 'node server.js' when the container starts
CMD ["node", "index.js"]